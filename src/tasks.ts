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
		const the_task = task.definition.task;
		if (the_task) {
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
  
    /**
     * The rake file containing the task
     */
    file?: string;

    /*
     * The makefile goal that this task operates on
     */
    goal: Goal;
};

async function getTasks(): Promise<Task[]> {
    var targets : Task[] = [];
    configuration.getAllBuildTargets().forEach((goals, dir) => {
        goals
            .filter((goal) => goal.flags & Goal.Flags.Linked_binary)
            .forEach((g) => {
                const kind: MyTaskDefinition = {
                    type: AutoToolsTaskProvider.myType,
                    task: g.goal || "unknown-task",
                    goal: g
                };
                if (g.flags & Goal.Flags.Linked_binary) {
                    var task = new Task(kind, TaskScope.Workspace, g.goal || "blah-name", "blah-source", new ProcessExecution(`${g.goal}`));
                    task.group = TaskGroup.Build;
                    targets.push(task);
                }
            })});
    return targets;
}
