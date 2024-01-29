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
import { assert, markTimeline } from 'console';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface RunDef {
    run : vscode.TestRun;
    cancel: vscode.CancellationToken;
    tmp_label: string | undefined;
    live: boolean;
    env: configuration.TestEnvironment;
}

const UpdateRe = /^Makefile:\d+: update target '(.+)' due to: (.+)$/;

const debuggable = new vscode.TestTag('debugme');
const applicable = new vscode.TestTag('applicable');
export const live = new vscode.TestTag('live');
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
  private testCompletedEvent: EventEmitter<void> = new EventEmitter<void>();
  private activeRuns = new WeakMap<vscode.TestItem, Map<vscode.TaskExecution,TestRun>>();

  public testCompleted(task: vscode.TaskExecution, test: TestItem, target: BuildTarget) : void {
    let runs = this.activeRuns.get(test);
    if (runs) {
        var run = runs.get(task);
        if (run) this.updateGoalTRS(run, test, readTRS(target));
    }

    this.isBusy = false;
    // extension.autotoolsDoneNoResult();
    this.testCompletedEvent.fire();
  }
  public suiteCompleted(task: vscode.TaskExecution) : void {
    // extension.autotoolsDoneNoResult();
    this.isBusy = false;
    this.testCompletedEvent.fire();
  }

  public run(test: TestItem, env: TestEnvironment) : void {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        env.run?.runHandler(new vscode.TestRunRequest([test], [], env.run), cancelToken.token);
        cancelToken.dispose();
    }
  }
  public async liverun(test: TestItem, env: TestEnvironment) : Promise<void> {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        this.runHandler(true, new vscode.TestRunRequest([test], [], env.run), cancelToken.token, env);
        cancelToken.dispose();
    }
  }

  public async debug(test: TestItem, env: TestEnvironment) : Promise<void> {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        var cancelToken = new vscode.CancellationTokenSource();
        try {
            env.debug?.runHandler(new vscode.TestRunRequest([test], [], env.run), cancelToken.token);
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
        let num_applicable_envs = envs.filter((env) => !env.dirs || env.dirs.includes(logpath)).length;
        if (num_applicable_envs)
            goal.test.description = localize("autotools.test.desc", "{0}/{1} environments tested", goal.trs?.results.size ?? 0, num_applicable_envs);
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

  resolveHandler (item: TestItem | undefined): Thenable<void> | void {
    // Store the root test item
    this.root = item;
  }

  public onSavedAll() : void {
    if (this.livecheckid) {
        var test = this.controller.items.get(this.livecheckid);
        if (test) {
            this.liverun(test, configuration.getCurrentTestEnvironment());
        }
    }
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
  public togglelivecheck(treeItem: vscode.TreeItem, test : vscode.TestItem) : void {
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
    if (treeItem.resourceUri) extension.suiteDecorator.update(treeItem.resourceUri);

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
      configuration.getTestEnvironments().map(env => {
        env.debug = this.controller.createRunProfile(
            localize('autotools.test.debug.profile.name', '{0}: Debug "{1}" environment', extension.pkginfo?.name || "Autotools", env.name),
            vscode.TestRunProfileKind.Debug,
            async(request, token) => {
              this.debugHandler(false, request, token, env);
            }, false, debuggable
          );

          env.run = this.controller.createRunProfile(
            localize('autotools.test.run.profile.name', '{0}: Test "{1}" environment', extension.pkginfo?.name || "Autotools", env.name),
            vscode.TestRunProfileKind.Run,
            async (request, token) => {
                this.runHandler(false, request, token, env);
            }, true/* , {id: env.name} */
          );
        });
  }
  public deactivate() : void {
    this.controller.dispose();
  }


  private runQueue : Map<RunDef, vscode.TestItem[]> =
    new Map<RunDef, vscode.TestItem[]>();



    runHandler(
        live: boolean,
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        env: configuration.TestEnvironment
    ) {
        let name: string; // FIXME: The name is not shown in vscode 1.77.3 - how about 1.85?
        if (live) {
            if (request.include?.length == 1) name = `Live check - ${request.include[0].label}`;
            else name = 'Live check @ ${env.name}';
        } else if (request.include?.length)
            name = `Test - ${request.include[0].label}${request.include?.length>1 ? ` +${request.include.length-1}` : ''}`;
        else name = `Test all @ ${env.name}`;

        const run = this.controller.createTestRun(request, name, false);
        const queue: vscode.TestItem[] = [];

        // Loop through all included tests, or all known tests, and add them to our queue
        let rundef : RunDef = {run: run, cancel: token, tmp_label: request.profile?.label, env: env, live: live};
        if (request.include) {
            let runnable_in_env : vscode.TestItem[] = [];
            for (const t of request.include) {
                // run.enqueued(t);
                if (!live && (!env.dirs || (t.uri && env.dirs.includes(path.basename(t.uri.path))))) {
                    let goal = this.testGoals.get(t);
                    if (goal) this.markSuiteEnqueued(run, goal, env);
                    runnable_in_env.push(t);
                }
            }
            this.runQueue.set(rundef, runnable_in_env);
        } else {
            let top_check = configuration.getAllBuildTargets().get('')?.get('check')?.test;
            if (top_check) this.runQueue.set(rundef, [top_check]);
        }

        this.runQueuedTests();
    }

    async debugHandler(
        live: boolean,
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        env: configuration.TestEnvironment
    ) {

        if (request.include) {
            for (const test of request.include) {
                let goal = this.testGoals.get(test);
                if (goal) {
                    try {
                        await extension.debugGoal(goal, test.parent?.id || "", env);
                    } catch (e) {
                        console.error("Failed to start debugger", e);
                    }
                }
            }
        }
    }

    private queueRunner: vscode.Disposable | undefined;
    private runningTask: vscode.Task | undefined;
    private activeRun : RunDef | undefined;
    private activeQueue : vscode.TestItem[] = [];
    private activeTest: vscode.TestItem | undefined;
    runQueuedTests() : void {
        if (!this.queueRunner) {
            this.queueRunner = this.testCompletedEvent.event(async e => {
                await this.advanceQueue();
            });
            this.startNextRun();
            this.testCompletedEvent.fire();
        }
    }
    private isBusy : boolean = false;
    public get busy() : boolean { return this.isBusy; }
    async advanceQueue() : Promise<void> {
        if (this.activeRun) {
            do {
                if (this.activeTest) {
                    //this.activeQueue = this.activeRun.cancel.isCancellationRequested ?
                        //this.activeQueue.filter(def => def != this.activeTest) : [];
                    if (!this.activeQueue.length) { // end of queued tests for this run
                        this.runQueue.delete(this.activeRun);
                        // this.activeRun.run.appendOutput(`Blah in ${this.activeRun.env.name} @ ${this.activeRun.tmp_label}\n`);
                        this.activeRun.run.end();
                        extension.updateAllGrids();
                        this.activeRun = undefined;
                        this.activeTest = undefined;

                        this.startNextRun();
                    }
                }
                if (!this.activeRun) {
                    this.queueRunner?.dispose();
                    this.queueRunner = undefined;
                    break;
                } else
                    await this.startNextTest();
            } while (this.activeRun && !this.activeTest);
        }
    }
    startNextRun() : void {
        let next = this.runQueue.entries().next();
        if (!next.done)
            [this.activeRun, this.activeQueue] = next.value;
    }
    async startNextTest() : Promise<void> {
        if (this.activeRun) {
            this.activeTest = this.activeQueue.pop();
            if (this.activeTest) {
                let goal = this.testGoals.get(this.activeTest);

                if (goal?.task instanceof Map) {
                    this.runningTask = this.activeRun.live ?
                        goal.livetask :
                        goal.task.get(this.activeRun.env)
                    assert(this.runningTask, "There must be a task for the env");
                    if (this.runningTask) {
                        this.activeRun.run.started(this.activeTest)
                        await extension.waitToTouchMakefiles();
                        vscode.tasks.executeTask(this.runningTask)
                            .then(e => (this.isBusy = true));
                    }
                } else
                    this.runningTask = undefined;
            }
        }
    }
    markSuiteEnqueued(run: vscode.TestRun, g: Goal, env: TestEnvironment) : void {
        if (g.test) {
            run.enqueued(g.test);
            if (g.depends)
                for (const sub of g.depends)
                    this.markSuiteEnqueued(run, sub, env);
        }
    }
}
