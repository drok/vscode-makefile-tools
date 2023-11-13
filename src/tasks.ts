/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Task, TaskDefinition, TaskScope, TaskGroup, TaskProvider, ProcessExecution, workspace } from 'vscode';
import { Goal } from './parser/gnumake';
import { error } from 'console';
import * as configuration from './configuration';
import { BuildTarget, t_all, t_none } from './make';
import { resolvePathToRoot, checkFileExistsSync } from './util';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { Script } from 'vm';
import { extension } from './extension';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export class AutoToolsBuildTaskProvider implements MyTaskProvider {
	readonly myType = 'build';
	private myPromise: Thenable<Task[]> | undefined = undefined;

	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public update() {
        var targets: Task[] = [];
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            goals
                .filter((goal) => goal.flags & (
                        Goal.Flags.Static_library |
                        Goal.Flags.Linked_binary
                        ))
                .forEach((g) => {
                    if (g.goal) {
                        const kind: BuildTask = {
                            type: this.myType,
                            target: new BuildTarget(dir, g.goal)
                        };
                        var task = new Task(kind, TaskScope.Workspace, "make " + (g.goal || "blah-name"),
                            localize("autotools.build.task", "autotools in {0}", dir),
                            new ProcessExecution(
                                configuration.getMakePath(),
                                (dir ? ['-C', dir] : [])
                                .concat(configuration.getConfigurationMakeArgs())
                                .concat(g.goal)));
                        task.group = TaskGroup.Build;
                        task.detail =
                            (g.flags & Goal.Flags.Linked_binary) ? localize("automake.program", "$(combine) $(file-binary) Build program") :
                            (g.flags & Goal.Flags.Static_library) ? localize("automake.ranlib", "$(combine) $(library) Build static library") :
                            localize("automake.build", "$(combine) Build");
                        targets.push(task);
                    }
                })});
        this.myPromise = Promise.resolve(targets);
    }

    public build(g : BuildTarget) : void {
        const kind: BuildTask = {
            type: this.myType,
            target: g
        };
        let top_builddir = configuration.getCurrentMakefileConfiguration().top_builddir;
        var task = new Task(kind, TaskScope.Workspace, "build '" + g.goal + "'",
            "autotools",
            new ProcessExecution(
                configuration.getMakePath(),
                (top_builddir ? ['-C', top_builddir] : [])
                .concat(g.builddir ? ['-C', g.builddir] : [])
                .concat(configuration.getCurrentMakefileConfiguration().makeArgs || [])
                .concat(g.goal)));
        task.group = TaskGroup.Build;
        //task.detail =
        //    (g.flags & Goal.Flags.Linked_binary) ? localize("automake.program", "$(combine) $(file-binary) Build program") :
        //    (g.flags & Goal.Flags.Static_library) ? localize("automake.ranlib", "$(combine) $(library) Build static library") :
        //    localize("automake.build", "$(combine) Build");
        vscode.tasks.executeTask(task);
    }
	public resolveTask(_task: Task): Task | undefined {
		const target = _task.definition.target;
        if (!target)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: BuildTask = <any>_task.definition;
        return new Task(definition, _task.scope ?? TaskScope.Workspace, target.goal ?? t_all.goal,
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (target.builddir ? ['-C', target.builddir] : [])
                .concat(configuration.getConfigurationMakeArgs())
                .concat(target.goal ?? t_all.goal)));
	}
}


export class AutoToolsTestTaskProvider implements MyTaskProvider {
	readonly myType = 'test';
	private myPromise: Thenable<Task[]> | undefined = undefined;

	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public update() {
        var targets: Task[] = [];
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            goals
                .filter((goal) => goal.flags & (
                        Goal.Flags.Test_Suite
                        ))
                .forEach((g) => {
                    if (g.goal) {
                        g.depends?.forEach((d) => {
                            const kind: TestTask = {
                                type: this.myType,
                                test: new BuildTarget(dir, d)
                            };
                            var task = new Task(kind, TaskScope.Workspace, "run test \'" + d + "\' in " + dir,
                            "autotools",
                            new ProcessExecution(
                                configuration.getMakePath(),
                                (dir ? ['-C', dir] : [])
                                // Treat the goal (test.log) a phony so it will always be remade.
                                .concat("--eval=.PHONY: " + d.goal)
                                .concat(configuration.getCurrentMakefileConfiguration().makeArgs || [])
                                .concat(d)));
                            task.group = TaskGroup.Test;
                            task.detail = localize("automake.test", "$(check) Run test '" + path.basename(d, ".log") + "'");
                            targets.push(task);
                        });
                    }
                })});
    
        this.myPromise = Promise.resolve(targets);
    }

	public resolveTask(_task: Task): Task | undefined {
		const test = _task.definition.test;
        if (!test)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        return new Task(definition, _task.scope ?? TaskScope.Workspace, test.goal,
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (test.builddir ? ['-C', test.builddir] : [])
                // up-to-date test.log files might already exist, they need
                // overwritten if the user runs the test again, hence
                // --always-make, but Makefile must not be remade,
                // because it means reconfiguration (infinite loop)
                .concat("--always-make", "--assume-old=Makefile")
                .concat(configuration.getConfigurationMakeArgs())
                .concat(test.goal)));
	}
}

export class AutoToolsCheckTaskProvider implements MyTaskProvider {
	readonly myType = 'check';
	private myPromise: Thenable<Task[]> | undefined = undefined;

    provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    update() {

        var targets : Task[] = [];
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            goals
            .filter((goal) => goal.flags & (
                    Goal.Flags.Test_Suite
                    ))
            .forEach((g) => {
                const kind: CheckTask = {
                    type: this.myType
                };
                var task = new Task(kind, TaskScope.Workspace, "run test suite in" + dir,
                "autotools",
                new ProcessExecution(
                    configuration.getMakePath(),
                    (dir ? ['-C', dir] : [])
                    .concat(configuration.getConfigurationMakeArgs())
                    .concat("check")));
                task.group = TaskGroup.Test;
                task.detail = localize("automake.check", "$(checklist) Test Suite");
                targets.push(task);
            });});
        this.myPromise = Promise.resolve(targets);
    }

	public resolveTask(_task: Task): Task | undefined {
		const check = _task.definition.check;
        if (!check)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        return new Task(definition, _task.scope ?? TaskScope.Workspace, "check",
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (check.builddir ? ['-C', check.builddir] : [])
                // up-to-date test.log files might already exist, they need
                // overwritten if the user runs the test again, hence
                // --always-make, but Makefile must not be remade,
                // because it means reconfiguration (infinite loop)
                .concat("--always-make", "--assume-old=Makefile")
                .concat(configuration.getConfigurationMakeArgs())
                .concat(definition.target.goal)
                .concat(check.TESTS ? 'TESTS=' +  check.TESTS.join(' ') : [])
                .concat(check.TEST_SUITE_LOG ? 'TEST_SUITE_LOG=' +  check.TEST_SUITE_LOG : [])));
	}
}

export interface MyTaskProvider extends TaskProvider {
    readonly myType: string;
    update(): void;
}

export class AutoToolsBootstrapTaskProvider implements MyTaskProvider {
	readonly myType = 'bootstrap';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public bootstrapTask?: vscode.Task;

    constructor() {
        let b = this.bootstrap_cmd();
        if (b) {
            const kind: BootstrapTask = {
                type: this.myType
            };
            this.bootstrapTask = new Task(kind, TaskScope.Workspace, b.join(' '),
                localize("autotools.bootstrap.task", "Bootstrap autotools"),
                new ProcessExecution(b[0], b.slice(1)));
            this.bootstrapTask.group = TaskGroup.Build;
            this.bootstrapTask.detail = localize("automake.bootstrap", "$(tools) Bootstrap project using '{0}'", b.join(' '));
            this.myPromise = Promise.resolve([this.bootstrapTask]);
        }
    }
	provideTasks(): Thenable<Task[]> | undefined {
        if (this.bootstrapTask) {
            return this.myPromise;
        }
        return Promise.reject();
	}

	resolveTask(_task: Task): Task | undefined {
        const definition: BootstrapTask = <any>_task.definition;
        let b = this.bootstrap_cmd();
        if (!b)
            return undefined;
        return new Task(definition, _task.scope ?? TaskScope.Workspace, "bootstrap",
            this.myType,
            new ProcessExecution(b[0], b.slice(1)));
	}

    private bootstrap_cmd(): string[] | undefined {
        if (!checkFileExistsSync(resolvePathToRoot("configure.ac")) && !checkFileExistsSync(resolvePathToRoot("configure.in"))) {
            return undefined;
        } else {
            let script = resolvePathToRoot("bootstrap");
            if (checkFileExistsSync(script))
                return [script];

            script = resolvePathToRoot("autogen.sh");
            if (checkFileExistsSync(script))
                return [script];
        }
        return ["autoreconf", "-fvi"];
    }
    update(): void {}

    public async bootstrap(): Promise<void> {
        if (this.bootstrapTask) {
            vscode.tasks.executeTask(this.bootstrapTask);
        }
    }
}

export interface BuildTask extends TaskDefinition {
    /*
     * The makefile goal that this task operates on
     */
    target?: BuildTarget;
};

interface TestTask extends TaskDefinition {
    /*
     * The test output log this task creates.
     */
    test?: BuildTarget;
};

interface CheckTask extends TaskDefinition {
    /*
     * Test suite arguments (default: none, ie, run 'make check' )
     */
    check?: CheckTarget;
};

export class CheckTarget {
    TESTS?: string[];
    TEST_SUITE_LOG?: string;
}

interface BootstrapTask extends TaskDefinition {
};
