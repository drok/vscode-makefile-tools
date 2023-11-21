/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { Task, TaskDefinition, TaskScope, TaskGroup, TaskProvider, ProcessExecution, workspace } from 'vscode';
import { Goal } from './parser/gnumake';
import { assert, error } from 'console';
import * as configuration from './configuration';
import { BuildTarget, t_all, t_none, readTRS, TRS, isSuspect } from './make';
import { resolvePathToRoot, checkFileExistsSync, createDirectorySync } from './util';
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

    public update(disposables: vscode.Disposable[]) {
        var targets: Task[] = [];
        let c = configuration.getCurrentMakefileConfiguration();
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Static_library | Goal.Flags.Linked_binary)) {
                    if (g.goal) {
                        const kind: BuildTask = {
                            type: this.myType,
                            target: new BuildTarget(dir, g.goal)
                        };
                        g.task = new Task(kind, TaskScope.Workspace, "build '" + g.goal + "' in " + dir,
                            "autotools",
                            new ProcessExecution(
                                configuration.getMakePath(),
                                (c.top_builddir ? ['-C', c.top_builddir] : [])
                                .concat(dir ? ['-C', dir] : [])
                                .concat(c.makeArgs || [])
                                .concat(g.goal)));
                        g.task.group = TaskGroup.Build;
                        g.task.detail =
                            (g.flags & Goal.Flags.Linked_binary) ? localize("automake.program", "$(combine) $(file-binary) Build program") :
                            (g.flags & Goal.Flags.Static_library) ? localize("automake.ranlib", "$(combine) $(library) Build static library") :
                            localize("automake.build", "$(combine) Build");
                        targets.push(g.task);
                    }
                }
            }
        });
        this.myPromise = Promise.resolve(targets);
    }

    public build(g : BuildTarget) : void {
        const kind: BuildTask = {
            type: this.myType,
            target: g
        };
        let c = configuration.getCurrentMakefileConfiguration();
        var task = new Task(kind, TaskScope.Workspace, "build '" + g.goal + "'",
            "autotools",
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(g.builddir ? ['-C', g.builddir] : [])
                .concat(c.makeArgs || [])
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
        let c = configuration.getCurrentMakefileConfiguration();
        return new Task(definition, _task.scope ?? TaskScope.Workspace, target.goal ?? t_all.goal,
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(target.builddir ? ['-C', target.builddir] : [])
                .concat(c.makeArgs || [])
                .concat(target.goal ?? t_all.goal)));
	}
}


export class AutoToolsTestTaskProvider implements MyTaskProvider {
	readonly myType = 'test';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public numFails : number = 0;
    public numTests : number = 0;
    public numUnknown : number = 0;
    public numSuspect : number = 0;

	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public update(disposables: vscode.Disposable[]) {
        var targets: Task[] = [];
        this.numFails = 0;
        this.numTests = 0;
        this.numUnknown = 0;
        this.numSuspect = 0;
        let c = configuration.getCurrentMakefileConfiguration();
            configuration.getAllBuildTargets().forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & Goal.Flags.Test_Suite) {
                    if (g.goal && g.depends) {
                        let rel = new vscode.RelativePattern(vscode.Uri.file(path.join(c.top_builddir, dir)), '*.trs');
                        let watcher =   vscode.workspace.createFileSystemWatcher(rel);
                        disposables.push(watcher
                            .onDidChange((uri) => { extension.trsChange(c, uri); }));
                        disposables.push(watcher
                            .onDidDelete((uri) => { extension.trsChange(c, uri); }));
                        disposables.push(watcher
                            .onDidCreate((uri) => { extension.trsChange(c, uri); }));

                        g.depends.forEach((d) => {
                            if(!d.goal)
                                throw new Error("Invalid test.depends");
                            let test = new BuildTarget(dir, d.goal);
                            const kind: TestTask = {
                                type: this.myType,
                                test: test
                            };
                            d.task = new Task(kind, TaskScope.Workspace, "run test \'" + d.goal + "\' in " + dir,
                            "autotools",
                            new ProcessExecution(
                                configuration.getMakePath(),
                                (c.top_builddir ? ['-C', c.top_builddir] : [])
                                .concat(dir ? ['-C', dir] : [])
                                .concat(c.makeArgs || [])
                                .concat(["-esi",
                                    "check",
                                    "TEST_LOGS=" + test.goal
                                ]), c.nolog));
                            d.task.group = TaskGroup.Test;
                            d.task.detail = localize("automake.test", "$(check) Run test '{0}'", path.basename(d.goal, ".log"));
                            targets.push(d.task);

                            /* Read existing TRS file to show correct last known status in the outline */
                            let trs = readTRS(test);
                            d.flags |= trs;
                            this.numFails += (trs == TRS.FAIL ? 1 : 0);
                            this.numUnknown += ((trs == TRS.NONE || trs == TRS.ERROR) ? 1 : 0);
                            this.numSuspect += (isSuspect(trs) ? 1 : 0);
                            this.numTests++;
                        });
                    }
                }
            }});
        this.myPromise = Promise.resolve(targets);
    }

	public resolveTask(_task: Task): Task | undefined {
		const test = _task.definition.test;
        if (!test)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        let c = configuration.getCurrentMakefileConfiguration();
        return new Task(definition, _task.scope ?? TaskScope.Workspace, test.goal,
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(test.builddir ? ['-C', test.builddir] : [])
                .concat(c.makeArgs || [])
                .concat(["-esi",
                    "check",
                    "TEST_LOGS=" + test.goal
                ]), c.nolog));
	}
}

export class AutoToolsCheckTaskProvider implements MyTaskProvider {
	readonly myType = 'check';
	private myPromise: Thenable<Task[]> | undefined = undefined;

    provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    update(disposables: vscode.Disposable[]) {

        var targets : Task[] = [];
        let c = configuration.getCurrentMakefileConfiguration();
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Test_Suite)) {
                const kind: CheckTask = {
                    type: this.myType,
                    builddir: dir
                };
                g.task = new Task(kind, TaskScope.Workspace, "run test suite in " + dir,
                "autotools",
                new ProcessExecution(
                    configuration.getMakePath(),
                    (c.top_builddir ? ['-C', c.top_builddir] : [])
                    .concat(dir ? ['-C', dir] : [])
                    .concat(c.makeArgs || [])
                    .concat("check")));
                g.task.group = TaskGroup.Test;
                g.task.detail = localize("automake.check", "$(checklist) Test Suite");
                targets.push(g.task);
            }}});
        this.myPromise = Promise.resolve(targets);
    }

	public resolveTask(_task: Task): Task | undefined {
		const check = _task.definition.check;
        if (!check)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        let c = configuration.getCurrentMakefileConfiguration();
        return new Task(definition, _task.scope ?? TaskScope.Workspace, "check",
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(check.builddir ? ['-C', check.builddir] : [])
                .concat(c.makeArgs || [])
                .concat(definition.target.goal)
                .concat(check.TESTS ? 'TESTS=' +  check.TESTS.join(' ') : [])
                .concat(check.TEST_SUITE_LOG ? 'TEST_SUITE_LOG=' +  check.TEST_SUITE_LOG : [])));
	}
}

export interface MyTaskProvider extends TaskProvider {
    readonly myType: string;
    update(disposables: vscode.Disposable[]): void;
}

export class AutoToolsBootstrapTaskProvider implements MyTaskProvider {
	readonly myType = 'autotools';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public bootstrapTask?: vscode.Task;
    public regenTask?: vscode.Task;
    public helpTask?: vscode.Task;
    private working: boolean = false;
    static manifests: string[] = [
            "configure.ac",
            "configure.in",
    ];
    constructor() {
        let b = this.bootstrap_cmd();
        if (b) {
            const kind: AutotoolsTask = {
                type: this.myType,
                action: 'bootstrap'
            };
            this.bootstrapTask = new Task(kind, TaskScope.Workspace, b.join(' '),
                localize("autotools.bootstrap.task", "Bootstrap autotools"),
                new ProcessExecution(b[0], b.slice(1)));
            this.bootstrapTask.group = TaskGroup.Build;
            this.bootstrapTask.detail = localize("automake.bootstrap", "$(tools) Bootstrap project using '{0}'", b.join(' '));

            const helpkind: AutotoolsTask = {
                type: this.myType,
                action: 'help'
            };
            this.helpTask = new Task(helpkind, TaskScope.Workspace,
                localize("autotools.configure.help.task", "Display package configuration options"),
                "Autotools task",
                new ProcessExecution("./configure", ["--help"]));
            this.helpTask.detail = localize("automake.configure.help", "$(tools) Output package configuration options using 'configure --help'");
        }
    }
	provideTasks(): Thenable<Task[]> | undefined {
        if (this.bootstrapTask) {
            return this.myPromise;
        }
        return Promise.reject();
	}

	resolveTask(_task: Task): Task | undefined {
        const definition: AutotoolsTask = <any>_task.definition;
        if (definition.action === 'bootstrap')
            return this.bootstrapTask;
        if (definition.action === 'regen')
            return this.regenTask;
        if (definition.action === 'help')
            return this.helpTask;
	}

    public bootstrap_cmd(): string[] | undefined {
        let configureAc = AutoToolsBootstrapTaskProvider.manifests.find((m) => checkFileExistsSync(resolvePathToRoot(m)));
        configuration.setConfigureAc(configureAc);
        if (!configureAc) {
            return undefined;
        } else {
            let script = resolvePathToRoot("bootstrap");
            if (checkFileExistsSync(script))
                return [script];

            script = resolvePathToRoot("autogen.sh");
            if (checkFileExistsSync(script))
                return [script];
            configuration.setConfigureAc(configureAc);
        }
        return ["autoreconf", "-fvi"];
    }
    public isBootstrapped(): boolean {
        return checkFileExistsSync(resolvePathToRoot("configure"));
    }
    update(disposables: vscode.Disposable[]): void {
        let c = configuration.getCurrentMakefileConfiguration();

        const regenkind: AutotoolsTask = {
            type: this.myType,
            action: 'regen'
        };
        this.regenTask = new Task(regenkind, TaskScope.Workspace, "Update Makefiles and headers",
            localize("autotools.update.task", "Configuration update"),
            new ProcessExecution(configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat('stamp-h1')));
        this.regenTask.group = TaskGroup.Build;
        this.regenTask.detail = localize("automake.update", "$(sync) Update Makefiles and headers. See [Autoconf output](https://www.gnu.org/software/autoconf/manual/autoconf-2.69/html_node/Output.html)");

        this.myPromise = Promise.resolve([this.regenTask]
            .concat(this.bootstrapTask ?? []));
    }

    public async bootstrap(): Promise<void> {
        if (this.bootstrapTask && !this.working) {
            vscode.tasks.executeTask(this.bootstrapTask).then(() => {
                this.working = true;
            });
        }
    }
    public async regen(): Promise<void> {
        // Use regenWorking to avoid restarting when already running.
        // Eg, Makefile.in is updated in the workspace, which triggers
        // a separate, unnecesary update.
        if (this.regenTask && !this.working) {
            vscode.tasks.executeTask(this.regenTask).then(() => {
                this.working = true;
            });
        }
    }
    public async help(): Promise<void> {
        if (this.helpTask) {
            vscode.tasks.executeTask(this.helpTask).then(() => {
                this.working = true;
            });
        }
    }
    public async configure(): Promise<boolean> {
        let c = configuration.getCurrentMakefileConfiguration();
        let success = false;

        const configurekind: AutotoolsTask = {
            type: this.myType,
            action: 'configure'
        };
        let destdir = resolvePathToRoot(c.top_builddir);
        try {
            if (destdir)
                createDirectorySync(destdir);

            let task = new Task(configurekind, TaskScope.Workspace,
                localize("autotools.configure.task", "Prepare build directory"),
                "Autotools task",
                new ProcessExecution(resolvePathToRoot("configure"), c.configureArgs || [],
                    {cwd : destdir}));
            task.detail = localize("automake.configure.help", "$(tools) Configure build directory");

            vscode.tasks.executeTask(task)
                .then((e) => {
                    this.working = e.task.execution ? true : false;
            });

            success = await new Promise<boolean>(resolve => {
                let disposable = vscode.tasks.onDidEndTaskProcess(e => {
                    if (e.execution.task.definition == configurekind) {
                        disposable.dispose();
                        resolve(e.exitCode === 0);
                    }
                });
            });
        } catch (e) {
            success = false;
        }
        return Promise.resolve(success);
    }
    public async autotoolsDone(): Promise<void> {
        this.working = false;
    }
}

export interface BuildTask extends TaskDefinition {
    /*
     * The makefile goal that this task operates on
     */
    target?: BuildTarget;
};

export interface TestTask extends TaskDefinition {
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

export interface AutotoolsTask extends TaskDefinition {
    "action": string;
};
