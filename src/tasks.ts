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

export class AutoToolsTaskProvider implements TaskProvider {
	static buildType = 'build';
	static testType = 'test';
	static checkType = 'check';
	static bootstrapType = 'bootstrap';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public bootstrapTask?: vscode.Task;

    constructor() {
        let b = this.bootstrap_cmd();
        if (b) {
            const kind: BootstrapTask = {
                type: AutoToolsTaskProvider.bootstrapType,
                task: "bootstrap"
            };
            this.bootstrapTask = new Task(kind, TaskScope.Workspace, "Bootstrap autotools",
                localize("autotools.bootstrap.task", "Bootstrap"),
                new ProcessExecution(b[0], b.slice(1)));
            this.bootstrapTask.group = TaskGroup.Build;
            this.bootstrapTask.detail = localize("automake.bootstrap", "$(tools) Bootstrap project using '" + b.join(' ') + "'");
        }
    }
	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public foundTasks() {
        this.myPromise = getTasks();
    }

	public resolveTask(_task: Task): Task | undefined {
		const task = _task.definition.task;
        if (!task) {
            return undefined;
        }
        switch (task) {
		case "build": {
			// resolveTask requires that the same definition object be used.
            const definition: BuildTask = <any>_task.definition;
			return new Task(definition, _task.scope ?? TaskScope.Workspace, definition.target.goal,
                AutoToolsTaskProvider.myType,
                new ProcessExecution(
                    configuration.getMakePath(),
                    (definition.target.builddir ? ['-C', definition.target.builddir] : [])
                    .concat(configuration.getConfigurationMakeArgs())
                    .concat(definition.target.goal)));
            }
            break;
		case "test": {
			// resolveTask requires that the same definition object be used.
			const definition: TestTask = <any>_task.definition;
			return new Task(definition, _task.scope ?? TaskScope.Workspace, definition.test.goal,
                AutoToolsTaskProvider.myType,
                new ProcessExecution(
                    configuration.getMakePath(),
                    (definition.target.builddir ? ['-C', definition.target.builddir] : [])
                    // up-to-date test.log files might already exist, they need
                    // overwritten if the user runs the test again, hence
                    // --always-make, but Makefile must not be remade,
                    // because it means reconfiguration (infinite loop)
                    .concat("--always-make", "--assume-old=Makefile")
                    .concat(configuration.getConfigurationMakeArgs())
                    .concat(definition.target.goal)));
            }
            break;
        case "bootstrap":
            return this.bootstrapTask;
    }

		return undefined;
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

    public async bootstrap(): Promise<void> {
        if (this.bootstrapTask) {
            vscode.tasks.executeTask(this.bootstrapTask);
        }
    }
}

interface BuildTask extends TaskDefinition {
    /**
     * The task name
     */
    task: string;

    /*
     * The makefile goal that this task operates on
     */
    target: BuildTarget;
};

interface TestTask extends TaskDefinition {
    /**
     * The task name
     */
    task: string;

    /*
     * The test output log this task creates.
     */
    test: BuildTarget;
};

interface BootstrapTask extends TaskDefinition {
    /**
     * The task name
     */
    task: string;
};

//     if (!checkFileExistsSync(resolvePathToRoot("configure"))) {

async function getTasks(): Promise<Task[]> {
    var targets : Task[] = [];
    configuration.getAllBuildTargets().forEach((goals, dir) => {
        goals
            .filter((goal) => goal.flags & (
                    Goal.Flags.Static_library |
                    Goal.Flags.Linked_binary |
                    Goal.Flags.Test_Suite
                    ))
            .forEach((g) => {
                if (g.goal && (g.flags &
                        (Goal.Flags.Static_library |
                        Goal.Flags.Linked_binary))) {
                    const kind: BuildTask = {
                        type: AutoToolsTaskProvider.myType,
                        task: "build",
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
                } else if (g.goal && g.flags & Goal.Flags.Test_Suite) {
                    g.depends?.forEach((d) => {
                        const kind: TestTask = {
                            type: AutoToolsTaskProvider.myType,
                            task: "test",
                            test: new BuildTarget(dir, d)
                        };
                        var task = new Task(kind, TaskScope.Workspace, "run test " + (d || "blah-name"),
                        localize("autotools.test.task", "autotools in {0}", dir),
                        new ProcessExecution(
                            configuration.getMakePath(),
                            (dir ? ['-C', dir] : [])
                            // up-to-date test.log files might already exist, they need
                            // overwritten if the user runs the test again, hence
                            // --always-make, but Makefile must not be remade,
                            // because it means reconfiguration (infinite loop)
                            .concat("--always-make", "--assume-old=Makefile")
                            .concat(configuration.getConfigurationMakeArgs())
                            .concat(d)));
                        task.group = TaskGroup.Test;
                        task.detail = localize("automake.test", "$(check) Run test '" + path.basename(kind.test.goal, ".log") + "'");
                        targets.push(task);
                    });
                    const kind: TestTask = {
                        type: AutoToolsTaskProvider.myType,
                        task: "check",
                        test: new BuildTarget(dir, "check")
                    };
                    var task = new Task(kind, TaskScope.Workspace, "run all tests",
                    localize("autotools.test.task", "autotools in {0}", dir),
                    new ProcessExecution(
                        configuration.getMakePath(),
                        (dir ? ['-C', dir] : [])
                        .concat(configuration.getConfigurationMakeArgs())
                        .concat(kind.test.goal)));
                    task.group = TaskGroup.Test;
                    task.detail = localize("automake.test", "$(checklist) Test Suite");
                    targets.push(task);
                }
            })});
    if (extension.taskProvider.bootstrapTask) {
        targets.push(extension.taskProvider.bootstrapTask);
    }
    return targets;
}
