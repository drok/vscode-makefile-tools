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
import { BuildTarget, t_all } from './make';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export class AutoToolsTaskProvider implements TaskProvider {
	static myType = 'autotools';
	private myPromise: Thenable<Task[]> | undefined = undefined;

	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public foundTasks() {
        this.myPromise = getTasks();
    }

	public resolveTask(task: Task): Task | undefined {
		const target = task.definition.target;
		if (target?.goal) {
			// resolveTask requires that the same definition object be used.
			const definition: MyTaskDefinition = <any>task.definition;
			return new Task(definition, task.scope ?? TaskScope.Workspace, definition.target.goal, AutoToolsTaskProvider.myType,
                new ProcessExecution(
                    configuration.getMakePath(),
                    (target.builddir ? ['-C', target.builddir] : [])
                    .concat(configuration.getConfigurationMakeArgs())
                    .concat(target.goal)));
            }
		return undefined;
	}
}

interface MyTaskDefinition extends TaskDefinition {
    /**
     * The task name
     */
    task: string;
  
    /*
     * The makefile goal that this task operates on
     */
    target: BuildTarget;
};

async function getTasks(): Promise<Task[]> {
    var targets : Task[] = [];
    configuration.getAllBuildTargets().forEach((goals, dir) => {
        goals
            .filter((goal) => goal.flags & (
                    Goal.Flags.Static_library |
                    Goal.Flags.Linked_binary
                    ))
            .forEach((g) => {
                if (g.goal) {
                    const kind: MyTaskDefinition = {
                        type: AutoToolsTaskProvider.myType,
                        task: g.goal,
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
                        (g.flags & Goal.Flags.Linked_binary) ? localize("automake.program", "Build program") :
                        (g.flags & Goal.Flags.Static_library) ? localize("automake.ranlib", "Build static library") :
                        localize("automake.build", "Build");
                    targets.push(task);
                }
            })});
    return targets;
}
