import * as path from 'path';
import { runInNewContext } from 'vm';
import * as vscode from 'vscode';
import { Goal, Make } from './parser/gnumake';
import { TRS } from './make';
import { TestController,
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

    }
}
export class MyTestController {
  private root: TestItem | undefined;
  private readonly controller: vscode.TestController;
  private runProfile: vscode.TestRunProfile | undefined;
  private debugProfile: vscode.TestRunProfile | undefined;
  private coverageProfile: vscode.TestRunProfile | undefined;
  private testGoals = new WeakMap<vscode.TestItem, Goal>();
  readonly debuggable = new vscode.TestTag('debuggable');
  // readonly items: TestItemCollection;


  public addSuite(dir: string, sub: Goal) : void {
    sub.test =  this.controller.createTestItem(
            dir || '/', dir || "Top Test Suite", undefined);
    this.testGoals.set(sub.test, sub);
  }
  public addTest(suite: TestItem, goal: Goal, trs: TRS) : void {
    goal.test = this.controller.createTestItem(
            goal.task?.name || "",
            goal.goal || "",
            vscode.Uri.file(resolvePathToRoot(path.join(logpath, goal.goal || ""))));
    this.testGoals.set(goal.test, goal);
    if (goal.depends?.length &&
            (goal.depends[0].flags & Goal.Flags.Linked_binary))
        goal.test.tags = [this.debuggable];
    suite.children.add(goal.test);
  }
  public addSubTest(suite: TestItem, sub: TestItem) : void {
    suite.children.add(sub);
  }

  public update(build_tree: Make, suite: TestItem) : void {
      this.controller.items.replace([suite]);
      const run = this.controller.createTestRun(
            new vscode.TestRunRequest(undefined, [], this.runProfile),
            "Autotools TRS",
        false
      );
      this.updateTRS(run, suite);
      run.end();
      // this.activate();
  }
  public trsChange(test: TestItem) : void {
    const run = this.controller.createTestRun(
        new vscode.TestRunRequest([test], [], this.runProfile),
        "Manual run",
    false
  );
  this.updateTRS(run, test);
  run.end();
}
  updateTRS(run: TestRun, test: TestItem) : void {
    let goal = this.testGoals.get(test);
    if (goal) {
        let trs = goal.flags & Goal.Flags.Test_Result_Mask;
        switch(trs) {
            case TRS.NONE: break;
            case TRS.ERROR: run.errored(test, new vscode.TestMessage("some error")); break;
            case TRS.SKIP: run.skipped(test); break;
            case TRS.PASS: run.passed(test); break;
            default: run.failed(test, new vscode.TestMessage(TRS_Info[trs].tooltip || "unk")); break;
        }
        goal.depends?.forEach(dep => dep.test && this.updateTRS(run, dep.test));
    }
    for(const [id, item]  of test.children)
        this.updateTRS(run, item);
  }
//  readonly items: TestItemCollection;

  constructor(public id: string, public label: string) {
    this.controller = vscode.tests.createTestController(id, label);
    const item = this.controller.createTestItem("first", "test");
    item.canResolveChildren = false;
    this.controller.items.add(item);
  }
  createTestRun(request: TestRunRequest, name?: string, persist?: boolean): TestRun {
    // Create a new TestRun instance
    const testRun = new MyTestRun("name", new vscode.CancellationTokenSource().token, false);

    // Add discovered test items to the test run
    //if (this.root) {
    //  this.addTestItemsToRun(testRun, this.root);
    //}

    return testRun;
  }

  createRunProfile(label: string, kind: vscode.TestRunProfileKind, runHandler: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => void | Thenable<void>, isDefault?: boolean | undefined, tag?: vscode.TestTag | undefined): vscode.TestRunProfile {
    return this.controller.createRunProfile(label, kind, runHandler, isDefault, tag);
  }
  private addTestItemsToRun(testRun: TestRun, item: TestItem): void {
    // Add the current test item to the test run
    // testRun.;

    // Recursively add child test items to the test run
    //for (const child of item.children) {
    //  this.addTestItemsToRun(testRun, child);
    //}
    return;
  }

  resolveHandler (item: TestItem | undefined): Thenable<void> | void {
    // Store the root test item
    this.root = item;
  }

  public activate(): void {
    //this.runProfile.configureHandler = (() => {
    //        return;
    //});

      this.debugProfile = this.controller.createRunProfile(
        'Debug',
        vscode.TestRunProfileKind.Debug,
        (request, token) => {
          this.runHandler(2, request, token);
        }, false, this.debuggable
      );

      this.runProfile = this.controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        (request, token) => {
          this.runHandler(1, request, token);
        }, true//, {id: 'run-id'}
    );
    if (false) { // TODO
      this.coverageProfile = this.controller.createRunProfile(
        'Coverage',
        vscode.TestRunProfileKind.Coverage,
        (request, token) => {
          this.runHandler(3, request, token);
        }
      );
    }
  }

    runHandler(
        mode: number,
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
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
        while (queue.length > 0 && !token.isCancellationRequested) {
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
                            await extension.debugGoal(goal, test.parent?.id || "");
                            run.enqueued(test);
                        }
                        break;
                    case vscode.TestRunProfileKind.Run:
                        if (test.children.size) {
                            test. children.forEach(test => queue.push(test));
                        } else {
                            if (goal.task) {
                                vscode.tasks.executeTask(goal.task);
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
            //    break;
            //}

            test.children.forEach(test => queue.push(test));
        }

        // Make sure to end the run after all tests have been executed:
        run.end();
    }

}