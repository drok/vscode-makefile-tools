import * as path from 'path';
import { runInNewContext } from 'vm';
import * as vscode from 'vscode';
import { Goal, Make } from './parser/gnumake';
import { BuildTarget, TRS, supportsTestEnvironments } from './make';
import { TestController,
        EventEmitter,
        TestItemCollection,
        TestRunRequest,
        TestItem,
        TestRun } from 'vscode';
import { SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS } from 'constants';
import { makeFullPath } from './util';
import { TRS_Info } from './make';
import { extension,
        openEditor } from './extension';
import { MakefileConfiguration } from './configuration';
import { resolvePathToRoot } from './util';
import * as util from './util';
import * as configuration from "./configuration";
import { TestEnvironment } from './configuration';
import { isDebuggable } from './debug';
import * as logger from './logger';
import * as fs from 'fs';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const UpdateRe = /^Makefile:\d+: update target '(.+)' due to: (.+)$/;

const debuggable = new vscode.TestTag('debugme');
const applicable = new vscode.TestTag('applicable');
const live = new vscode.TestTag('live');
const tags_debuggable = [debuggable];
const tags_debuggable_live = [debuggable, live];
const tags_applicable = [applicable];
const tags_applicable_live = [applicable, live];
const tags_live = [live];
const tags_debuggable_applicable = [debuggable, applicable];
const tags_debuggable_applicable_live = [debuggable, applicable, live];
const tags_none : vscode.TestTag[] = [];

const tagtable : Map<string, vscode.TestTag[]> = new Map([
    [tags_none.map<string>(i => i.id).sort().join(','), tags_none],
    [tags_applicable.map<string>(i => i.id).sort().join(','), tags_applicable],
    [tags_debuggable.map<string>(i => i.id).sort().join(','), tags_debuggable],
    [tags_live.map<string>(i => i.id).sort().join(','), tags_live],
    [tags_debuggable_live.map<string>(i => i.id).sort().join(','), tags_debuggable_live],
    [tags_applicable_live.map<string>(i => i.id).sort().join(','), tags_applicable_live],
    [tags_debuggable_applicable.map<string>(i => i.id).sort().join(','), tags_debuggable_applicable],
    [tags_debuggable_applicable_live.map<string>(i => i.id).sort().join(','), tags_debuggable_applicable_live],
])
function addTag(tag: vscode.TestTag, test: TestItem) : vscode.TestTag[] | undefined {
    if (test.tags.includes(tag)) return undefined;
    var broken : string = [...test.tags,tag].map<string>(t => t.id).sort().join(',');
    var has : vscode.TestTag[] | undefined = tagtable.get(broken);
    if (has)
        return has;
    return undefined;
}
function delTag(tag: vscode.TestTag, test: TestItem) : vscode.TestTag[] | undefined {
    if (!test.tags.includes(tag)) return undefined;
    var broken : string = test.tags.filter(t => t !== tag).map<string>(t => t.id).sort().join(',');
    var has : vscode.TestTag[] | undefined = tagtable.get(broken);
    if (has)
        return has;
    return undefined;
}

function readTRS(b: BuildTarget) : TRS
{
    let c = configuration.getCurrentMakefileConfiguration();

    let trs = util.resolvePathToRoot(path.join(c.top_builddir, b.builddir, path.basename(b.goal, ".log") + ".trs"));
    try {
        const fileContent = fs.readFileSync(trs, 'utf8');
        if (!fileContent)
            return TRS.NONE;
        const lines = fileContent.split('\n');

        //let testResult = '';
        let globalTestResult = '';

        for (const line of lines) {
            //if (line.startsWith(':test-result:')) {
            //    testResult = line.split(':test-result:')[1].trim();
            //} else
            if (line.startsWith(':global-test-result:')) {
                globalTestResult = line.split(' ')[1];
            }
        }
        switch (/*testResult || */globalTestResult) {
            case "XPASS": return TRS.XPASS;
            case "PASS": return TRS.PASS;
            case "SKIP": return TRS.SKIP;
            case "ERROR": return TRS.ERROR;
            case "FAIL": return TRS.FAIL;
            case "XFAIL": return TRS.XFAIL;
            default: return TRS.ERROR;
        }
    }
    catch (e) {
        return TRS.NONE; // File does not exist
    }
}

export class MyTestController {
  private root: TestItem | undefined;
  private readonly controller: vscode.TestController;
  // private runProfiles: vscode.TestRunProfile[];
  // private debugProfiles: vscode.TestRunProfile[];
  private coverageProfile: vscode.TestRunProfile | undefined;
  private testGoals = new WeakMap<vscode.TestItem, Goal>();
  private testCompletedEvent: EventEmitter<TestItem> = new EventEmitter<TestItem>();
  private activeRuns = new WeakMap<vscode.TestItem, Set<TestRun>>();

  public testCompleted(test: TestItem, target: BuildTarget) : void {
    let runs = this.activeRuns.get(test);
    if (runs) {
        runs.forEach(run => this.updateGoalTRS(run, test, readTRS(target)));
    }

    this.testCompletedEvent.fire(test);
  }
  public suiteCompleted(suite: TestItem) : void {
    this.testCompletedEvent.fire(suite);
  }

  public async run(test: TestItem, env: TestEnvironment) : Promise<void> {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        await env.run?.runHandler(new vscode.TestRunRequest([test], [], env.run), cancelToken.token);
        cancelToken.dispose();
    }
  }
  public async liverun(test: TestItem, env: TestEnvironment) : Promise<void> {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        await this.runHandler(true, vscode.TestRunProfileKind.Run, new vscode.TestRunRequest([test], [], env.run), cancelToken.token, env);
        cancelToken.dispose();
    }
  }

  public async debug(test: TestItem, env: TestEnvironment) : Promise<void> {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        try {
            await env.debug?.runHandler(new vscode.TestRunRequest([test], [], env.run), cancelToken.token);
        } catch (e) {
            console.error("Failed to start debugger", test);
        }
        cancelToken.dispose();

    }
  }
  public addSuite(c: MakefileConfiguration, dir: string, sub: Goal) : void {
    sub.test =  this.controller.createTestItem(
            dir || '/', dir || "Top Test Suite",
            vscode.Uri.file(resolvePathToRoot(path.join(c.top_builddir, dir, sub.goal || ""))
            ));
    this.testGoals.set(sub.test, sub);
    sub.test.tags = tags_none;
  }
  public addTest(c: MakefileConfiguration, logpath: string, suite: TestItem, goal: Goal) : void {
//    var testName : string = goal.task instanceof vscode.Task ? goal.task.name :
//        goal.task instanceof Map ? goal.task.get
    goal.test = this.controller.createTestItem(
            path.join(logpath, goal.goal ||""),
            goal.goal || "",
            vscode.Uri.file(resolvePathToRoot(path.join(c.top_builddir, logpath, goal.goal || ""))));
    this.testGoals.set(goal.test, goal);
    if (goal.depends?.length && isDebuggable(goal.depends[0]))
        goal.test.tags = tags_debuggable;
    else
        goal.test.tags = tags_none;

    if (supportsTestEnvironments()) {
        let envs = configuration.getTestEnvironments();
        if (envs.length)
            goal.test.description = localize("autotools.test.desc", "{0}/{1} environments tested", goal.trs?.num, envs.length);
    }

    suite.children.add(goal.test);
  }
  public addSubTest(suite: TestItem, sub: TestItem) : void {
    suite.children.add(sub);
  }

  public clear() : void {
    this.controller.items.replace([]);
  }
  public update(suite: TestItem) : void { // FIXME: call with suite[], and createTestRun once for all suites.
      this.controller.items.add(suite);
      var env = configuration.getCurrentTestEnvironment();
      const run = this.controller.createTestRun(
                new vscode.TestRunRequest(undefined, [], env.run),
                "Autotools TRS on " + env.run?.label,
            false
        );
        this.updateTRS(run, suite);
        run.end();
      // this.activate();
  }
  public trsChange(test: TestItem) : void {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var env = configuration.getCurrentTestEnvironment();
        let run = this.controller.createTestRun(
                new vscode.TestRunRequest([test], [], env.run),
                "Manual run",
                false);
        this.updateTRS(run, test);
        run.end();
    }
  }
  updateGoalTRS(run: TestRun, test: TestItem, trs: TRS | undefined) : void {
    switch(trs) {
        case TRS.NONE: break;
        case TRS.ERROR: run.errored(test, new vscode.TestMessage("See log file")); break;
        case TRS.SKIP: run.skipped(test); break;
        case TRS.PASS: run.passed(test); break;
        case TRS.FAIL: run.failed(test, new vscode.TestMessage(TRS_Info[trs].tooltip || "fail")); break;
        default: run.failed(test, new vscode.TestMessage(TRS_Info[TRS.FAIL].tooltip || "unk")); break;
    }
  }
  updateTRS(run: TestRun, test: TestItem) : void {
    let goal = this.testGoals.get(test);
    if (goal && !(goal.flags & Goal.Flags.Test_Suite))
        this.updateGoalTRS(run, test, goal.trs?.global);
    else for(const [id, item]  of test.children)
        this.updateTRS(run, item);
  }

  constructor(public id: string, public label: string, public livecheckid: string | undefined) {
    this.controller = vscode.tests.createTestController(id, label);
    this.activate();
  }

  createRunProfile(label: string, kind: vscode.TestRunProfileKind, runHandler: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => void | Thenable<void>, isDefault?: boolean | undefined, tag?: vscode.TestTag | undefined): vscode.TestRunProfile {
    return this.controller.createRunProfile(label, kind, runHandler, isDefault, tag);
  }
  resolveHandler (item: TestItem | undefined): Thenable<void> | void {
    // Store the root test item
    this.root = item;
  }

  public async onSavedAll() : Promise<void> {
    if (this.livecheckid) {
        var test = this.controller.items.get(this.livecheckid);
        if (test) {
            await this.liverun(test, configuration.getCurrentTestEnvironment());
        }
    }
    return Promise.resolve();
  }

  public async onOpenedDocument() : Promise<void> {

    // Do nothing if the dry-running is in progress
    //var stats = make.getStats();
    if (!this.controller.items.size) return Promise.reject();

    return new Promise<void>(async (resolve, reject) => {
        var targets = configuration.getAllBuildTargets();
        var runs : Map<string,string[]> = new Map();
        var applicable_tests : Set<vscode.TestItem>= new Set();
        vscode.window.tabGroups.all.forEach(group => {
            group.tabs.forEach(tab => {
                if (tab.input instanceof vscode.TabInputText) {
                    var wsdir = vscode.workspace.getWorkspaceFolder(tab.input.uri)?.uri.fsPath;
                    if (wsdir) {
                        var dir = path.relative(wsdir,path.dirname(tab.input.uri.fsPath));
                        var reltargets = targets.get(dir);
                        if (reltargets) {
                            var has_sources = runs.get(dir);
                            var sources : string[] = has_sources || [];
                            sources.push(path.basename(tab.input.uri.fsPath));
                            if (!has_sources) runs.set(dir, sources);
                        }
                    }
                }
            });
        });
        for (const dir of Array.from(runs.keys())) {
            var sources = runs.get(dir) || [];
            var dirtargets = targets.get(dir) || new Map<string,Goal>();
            if ((await util.spawnChildProcess(
                extension.dryRunner,
                    ["-r", "--output-sync=none", "--trace", "--dry-run", "--silent", "-C", dir, "test-suite.log"]
                    .concat([...sources.map(x => `--assume-new=${x}`)]),
                resolvePathToRoot(configuration.getCurrentMakefileConfiguration().top_builddir),
                true, true,
                undefined,
                (x) => {
                    x.split('\n').forEach(line => {
                        let match = UpdateRe.exec(line);
                        if (match && match[1] && targets) {
                            let test = dirtargets.get(match[1])?.test;
                            if (test) applicable_tests.add(test);
                            // TODO: erase applicable tag
                        }
                    })
                    //var ac_init = x.trimEnd().split(':');
                    //if (ac_init && ac_init.length > 4 && ac_init[0] == "configure.ac" && ac_init[2] == "AC_INIT") {
                    //    theinfo = {
                    //        "name": ac_init[3],
                    //        "version": ac_init[4] ?? '',
                    //        "bugreport": ac_init[5] ?? '',
                    //        // 7 is tarname
                    //        "url": ac_init[7] ?? '',
                    //        "automake": "unk",
                    //    };
                    //}
                }, undefined)).returnCode != 0)
                reject();
        }
        targets.forEach((v,dir) => {
            v.forEach((goal,name) => {
                if (goal.test) {
                    var newtags = applicable_tests.has(goal.test) ? addTag(applicable, goal.test) : delTag(applicable, goal.test);
                    if (newtags)
                        goal.test.tags = newtags;
                }
            });
        });
      resolve();
    });
  }

  private livecheck : vscode.Uri | undefined;
  public togglelivecheck(test : vscode.TestItem) : void {
    var remove = test.tags.includes(live);
    var newtags = remove ? delTag(live, test) : addTag(live, test);
    if (newtags !== undefined) {
        this.livecheck = !remove ? test.uri : undefined;
        this.livecheckid = !remove ? test.id : undefined;
        extension.getState().liveCheckId = this.livecheckid;


        test.tags = newtags;
        test.children.forEach(child => {
            if (!child.children.size) {
                var newtags = remove ? delTag(live, child) : addTag(live, child);
                if (newtags) child.tags = newtags;
            }
        });
    }
  }
  public restoreLiveCheck() : void {
      if (this.livecheckid) {
          var test = this.controller.items.get(this.livecheckid);
          if (test) {
              test.tags = addTag(live, test) || test.tags;
              test.children.forEach(child => {
                  if (!child.children.size)
                    child.tags = addTag(live, child) || child.tags;
              });
          }
      }
  }
  public activate(): void {
      configuration.getTestEnvironments().map( env => {
        env.debug = this.controller.createRunProfile(
            localize('autotools.test.debug.profile.name', '{0}: Debug "{1}" environment', extension.pkginfo?.name || "Autotools", env.name),
            vscode.TestRunProfileKind.Debug,
            (request, token) => {
              this.runHandler(false, vscode.TestRunProfileKind.Debug, request, token, env);
            }, false, debuggable
          );

          env.run = this.controller.createRunProfile(
            localize('autotools.test.run.profile.name', '{0}: Test "{1}" environment', extension.pkginfo?.name || "Autotools", env.name),
            vscode.TestRunProfileKind.Run,
            (request, token) => {
                this.runHandler(false, vscode.TestRunProfileKind.Run, request, token, env);
            }, true/* , {id: env.name} */
          );
        });

/*
    if (false) { // TODO
      this.coverageProfile = this.controller.createRunProfile(
        'Coverage',
        vscode.TestRunProfileKind.Coverage,
        (request, token) => {
          this.runHandler(vscode.TestRunProfileKind.Coverage, request, token);
        }
      );
    }
*/
  }
  public deactivate() : void {
    this.controller.dispose();
  }

    async runHandler(
        live: boolean,
        kind: vscode.TestRunProfileKind,
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        env: configuration.TestEnvironment
    ) {
        const run = this.controller.createTestRun(request);
        const queue: vscode.TestItem[] = [];

        // Loop through all included tests, or all known tests, and add them to our queue
        if (request.include) {
        request.include.forEach(test => queue.push(test));
        } else {
        this.controller.items.forEach(test => queue.push(test));
        }

        // For every test that was queued, try to run it. Call run.passed() or run.failed().
        // The `TestMessage` can contain extra information, like a failing location or
        // a diff output. But here we'll just give it a textual message.
        while (queue.length > 0 && !token?.isCancellationRequested) {
            const test = queue.pop()!;

            // Skip tests the user asked to exclude
            if (request.exclude?.includes(test)) {
                continue;
            }
            let goal = this.testGoals.get(test);
            if (goal) {
                switch (kind) {
                    case vscode.TestRunProfileKind.Debug:
                        if (test.children.size) {
                            // test suite, open the Makefile.am
                            let makefile = path.join(test.id, "Makefile.am");
                            openEditor(makefile);
                        } else {
                            // test case, open in in the debugger
                            try {
                                await extension.debugGoal(goal, test.parent?.id || "", env);
                            } catch (e) {
                                console.error("Failed to start debugger", e);
                            }
                        }
                        run.started(test);
                        break;
                    case vscode.TestRunProfileKind.Run:
                            if (goal.task) {
                                if (live) {
                                    if (goal.livetask)
                                        vscode.tasks.executeTask(goal.livetask);
                                } else if (goal.task instanceof vscode.Task)
                                    vscode.tasks.executeTask(goal.task);
                                else {
                                    var task = goal.task.get(env.name);
                                    if (task) vscode.tasks.executeTask(task);
                                }
                                let runs = this.activeRuns.get(test);
                                if (!runs) {
                                    runs = new Set<TestRun>();
                                    this.activeRuns.set(test, runs);
                                }
                                runs.add(run);
                                await this.waitForTestFinish(test);
                                runs.delete(run);
                                if (runs.size == 0)
                                    this.activeRuns.delete(test);
                            }
                        break;
                }
            }
        }
        // Make sure to end the run after all tests have been executed:
        run.end();
    }
    waitForTestFinish(waitFor: TestItem) : Promise<void> {
        return new Promise(resolve => {
            this.testCompletedEvent.event(e =>
                (e == waitFor) && resolve());
        });
    }
}