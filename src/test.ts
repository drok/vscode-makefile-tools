import * as path from 'path';
import { runInNewContext } from 'vm';
import * as vscode from 'vscode';
import { Goal, Make } from './parser/gnumake';
import { BuildTarget, TRS, readTRS } from './make';
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
import * as configuration from "./configuration";
import { TestEnvironment } from './configuration';
import { isDebuggable } from './debug';

export class MyTestController {
  private root: TestItem | undefined;
  private readonly controller: vscode.TestController;
  // private runProfiles: vscode.TestRunProfile[];
  // private debugProfiles: vscode.TestRunProfile[];
  private coverageProfile: vscode.TestRunProfile | undefined;
  private testGoals = new WeakMap<vscode.TestItem, Goal>();
  readonly debuggable = new vscode.TestTag('debuggable');
  private testCompletedEvent: EventEmitter<TestItem> = new EventEmitter<TestItem>();
  private activeRuns = new WeakMap<vscode.TestItem, Set<TestRun>>();

  public testCompleted(test: TestItem, target: BuildTarget) : void {
    let runs = this.activeRuns.get(test);
    if (runs) {
        runs.forEach(run => this.updateGoalTRS(run, test, readTRS(target)));
    }

    this.testCompletedEvent.fire(test);
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
            vscode.Uri.file(path.join(c.top_builddir, dir, sub.goal || "")
            ));
    this.testGoals.set(sub.test, sub);
  }
  public addTest(logpath: string, suite: TestItem, goal: Goal, trs: TRS) : void {
//    var testName : string = goal.task instanceof vscode.Task ? goal.task.name :
//        goal.task instanceof Map ? goal.task.get
    goal.test = this.controller.createTestItem(
            path.join(logpath, goal.goal ||""),
            goal.goal || "",
            vscode.Uri.file(resolvePathToRoot(path.join(logpath, goal.goal || ""))));
    this.testGoals.set(goal.test, goal);
    if (goal.depends?.length && isDebuggable(goal.depends[0]))
        goal.test.tags = [this.debuggable];
    suite.children.add(goal.test);
  }
  public addSubTest(suite: TestItem, sub: TestItem) : void {
    suite.children.add(sub);
  }

  public clear() : void {
    this.controller.items.replace([]);
  }
  public update(suite: TestItem) : void {
      this.controller.items.add(suite);
      configuration.getTestEnvironments().forEach(env => {
        const run = this.controller.createTestRun(
                new vscode.TestRunRequest(undefined, [], env.run),
                "Autotools TRS on " + env.run?.label,
            false
        );
        this.updateTRS(run, suite);
        run.end();
      });
      // this.activate();
  }
  public trsChange(test: TestItem) : void {
    const runs = this.activeRuns.get(test);
    if (!runs) {
        // do nothing if a run is waiting for this
        configuration.getTestEnvironments().forEach(env => {
            let run = this.controller.createTestRun(
                new vscode.TestRunRequest([test], [], env.run),
                "Manual run",
                false);
            this.updateTRS(run, test);
            run.end();
        });
    }
}
  updateGoalTRS(run: TestRun, test: TestItem, trs: TRS) : void {
    switch(trs) {
        case TRS.NONE: break;
        case TRS.ERROR: run.errored(test, new vscode.TestMessage("See log file")); break;
        case TRS.SKIP: run.skipped(test); break;
        case TRS.PASS: run.passed(test); break;
        default: run.failed(test, new vscode.TestMessage(TRS_Info[trs].tooltip || "unk")); break;
    }
  }
  updateTRS(run: TestRun, test: TestItem) : void {
    let goal = this.testGoals.get(test);
    if (goal && !(goal.flags & Goal.Flags.Test_Suite))
        this.updateGoalTRS(run, test, goal.flags & Goal.Flags.Test_Result_Mask);
    for(const [id, item]  of test.children)
        this.updateTRS(run, item);
  }

  constructor(public id: string, public label: string) {
    this.controller = vscode.tests.createTestController(id, label);
  }

  createRunProfile(label: string, kind: vscode.TestRunProfileKind, runHandler: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => void | Thenable<void>, isDefault?: boolean | undefined, tag?: vscode.TestTag | undefined): vscode.TestRunProfile {
    return this.controller.createRunProfile(label, kind, runHandler, isDefault, tag);
  }
  resolveHandler (item: TestItem | undefined): Thenable<void> | void {
    // Store the root test item
    this.root = item;
  }

  public activate(): void {
      configuration.getTestEnvironments().map( env => {
        env.debug = this.controller.createRunProfile(
            'Debug',
            vscode.TestRunProfileKind.Debug,
            (request, token) => {
              this.runHandler(vscode.TestRunProfileKind.Debug, request, token, env);
            }, false, this.debuggable
          );

          env.run = this.controller.createRunProfile(
            env.name,
            vscode.TestRunProfileKind.Run,
            (request, token) => {
                this.runHandler(vscode.TestRunProfileKind.Run, request, token, env);
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
                        if (test.children.size) {
                            test. children.forEach(test => queue.push(test));
                        } else {
                            if (goal.task) {
                                if (goal.task instanceof vscode.Task)
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