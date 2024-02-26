/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import { Task, TaskDefinition, TaskScope, TaskGroup, TaskProvider,
    ProcessExecution, ShellExecution } from 'vscode';
import { Goal } from './parser/gnumake';
import * as configuration from './configuration';
import { FolderConfig, TestEnvironment } from './configuration';
import { BuildTarget, t_all, t_none, readTRS, TRS, isSuspect, emptyRunStats } from './make';
import { checkFileExistsSync, createDirectorySync } from './util';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { extension, telemetry } from './extension';
import * as util from './util';
import * as logger from './logger';
import { env } from 'process';
import * as ui from './ui';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { getStartTime } from './tele';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const presentSilent : vscode.TaskPresentationOptions = {
    reveal: vscode.TaskRevealKind.Silent,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: false }
const defaultCheckPresentation : vscode.TaskPresentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    echo: false,
    showReuseMessage: false }


const boostrap_scripts : string[] = [
    "bootstrap",
    "bootstrap.sh",
    "autogen.sh",
];

export class AutoToolsBuildTaskProvider implements MyTaskProvider {
	readonly myType = 'build';
    private all: Map<vscode.WorkspaceFolder, Task[]> = new Map();

    constructor(private fc: FolderConfig) {}
	public provideTasks(): Thenable<Task[]> | undefined {
        let tasks : Task[] = [];
        this.all.forEach((v,k) => tasks.push(...v));
        return new Promise(r => tasks);
	}

    changeConfiguration() : void {
        this.all.delete(this.fc.folder);
    }
    public update() : boolean {
        let c = this.fc.buildConfig;
        var targets: Task[] = [];
        this.fc.buildTargets.forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Linked_binary)) {
                    if (g.goal) {
                        const kind: BuildTask = {
                            type: this.myType,
                            folderIndex: this.fc.folder.index,
                            target: new BuildTarget(dir, g.goal)
                        };
                        g.task = new Task(kind, TaskScope.Workspace, "build " + g.goal + (dir ? (' in ' + dir) : ' at the top'),
                            "autotools",
                            new ProcessExecution(
                                configuration.getMakePath(),
                                (c.top_builddir ? ['-C', c.top_builddir] : [])
                                .concat(dir ? ['-C', dir] : [])
                                .concat(c.makeArgs || [])
                                .concat(g.goal)), "$gcc");
                        g.task.group = TaskGroup.Build;
                        g.task.detail =
                            (g.flags & Goal.Flags.Linked_binary) ? localize("automake.program", "$(combine) $(file-binary) Build program") :
                            localize("automake.build", "$(combine) Build");
                        targets.push(g.task);
                    }
                }
            }
        });
        this.all.set(this.fc.folder, targets);
        return false;
    }

    public build(g : BuildTarget) : void {
        const kind: BuildTask = {
            type: this.myType,
            folderIndex: this.fc.folder.index,
            target: g
        };
        let c = this.fc.buildConfig;
        var task = new Task(kind, TaskScope.Workspace, "build " + g.goal,
            "autotools",
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(g.builddir ? ['-C', g.builddir] : [])
                .concat(c.makeArgs || [])
                .concat(g.goal)),"$gcc");
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
        let fc = configuration.findFolderConfigByIndex(definition.folderIndex);
        if (fc)
            return new Task(definition, _task.scope ?? TaskScope.Workspace, target.goal ?? t_all.goal,
                this.myType,
                new ProcessExecution(
                    configuration.getMakePath(),
                    (fc.buildConfig.top_builddir ? ['-C', fc.buildConfig.top_builddir] : [])
                    .concat(target.builddir ? ['-C', target.builddir] : [])
                    .concat(fc.buildConfig.makeArgs || [])
                    .concat(target.goal ?? t_all.goal)),"$gcc");
        return undefined;
	}
}


export class AutoToolsTestTaskProvider implements MyTaskProvider {
	readonly myType = 'test';
    public numFails : number = 0;
    public numTests : number = 0;
    public numUnknown : number = 0;
    public numSuspect : number = 0;

    private all: Map<vscode.WorkspaceFolder, Task[]> = new Map();

    constructor(private fc: FolderConfig) {}
    public provideTasks(): Thenable<Task[]> | undefined {
        let tasks : Task[] = [];
        this.all.forEach((v,k) => tasks.push(...v));
        return new Promise(r => tasks);
	}

    changeConfiguration() : void {
        this.all.delete(this.fc.folder);
    }

    public update() : boolean {
        let c = this.fc.buildConfig;
        var targets: Task[] = [];
        this.numFails = 0;
        this.numTests = 0;
        this.numUnknown = 0;
        this.numSuspect = 0;
        let tc = this.fc.testController;
        let e = this.fc.testEnvironments;
        let updateBadge : boolean = false;
        this.fc.buildTargets.forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & Goal.Flags.Test_Suite) {
                    g.test || tc?.addSuite(c, dir, g);
                    if (g.goal && g.depends) {
                        let envs = FilterEnvsByDir(e, dir);
                        let ME_KEEP_ENV = KeepList(envs);
                        g.depends.forEach((d) => {
                            if(!d.goal)
                                throw new Error("Invalid test.depends");
                            let dgoal : string = d.goal;
                            let test = new BuildTarget(dir, dgoal);
                            const kind: TestTask = {
                                type: this.myType,
                                folderIndex: this.fc.folder.index,
                                test: test
                            };
                            var newMap : Map<TestEnvironment, vscode.Task> = new Map();
                            d.task = newMap;
                            envs.forEach((env) => {
                                var newTask = new Task(kind, TaskScope.Workspace,
                                    "Run test \'" + dgoal + "\' " + ((dir ? ('in ' + dir) : 'at the top') + (' @ ' + env.name)),
                                "autotools",

                                new ProcessExecution(
                                    configuration.getMakePath(),
                                    (dir ? ['-C', dir] : [])
                                    .concat(c.makeArgs || [])
                                    .concat(["-Res",
                                        "me-check",
                                        `ME_KEEP_ENV=${ME_KEEP_ENV}`,
                                        "--eval=include Mergesium.rules",
                                        "TEST_LOGS=" + test.goal
                                    ]), env.testExecOptions),"$gcc");
                                newTask.group = TaskGroup.Test;
                                newTask.detail = localize("automake.test", "$(check) Run test '{0}'", path.basename(dgoal, ".log"));
                                newTask.presentationOptions = presentSilent;
                                newMap.set(env, newTask);
                                targets.push(newTask);
                            });

                            /* Read existing TRS file to show correct last known status in the outline */
                            d.trs = readTRS(test, this.fc);
                            //let current : TRS = d.trs.results.get(cte.hashCode) ?? TRS.NONE;
                            let results : number[] = emptyRunStats();
                            d.trs.results.forEach(v => results[v]++);
                            this.numFails += results[TRS.FAIL] + results[TRS.XPASS];
                            this.numUnknown += results[TRS.NONE] + results[TRS.ERROR] + (envs.length - d.trs.results.size);
                            this.numSuspect += results[TRS.ERROR] + results[TRS.XFAIL];
                            this.numTests+=envs.length;

                            updateBadge = this.fc.updateTRSInPanel(undefined,d,dir) || updateBadge;
                            // tc.addTest(suite, d, trs);
                        });
                    }
                }
            }});
        this.all.set(this.fc.folder, targets);
        return updateBadge;
    }

	public resolveTask(_task: Task): Task | undefined {
		const test = _task.definition.test;
        if (!test)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        let fc = configuration.findFolderConfigByIndex(definition.folderIndex);
        if (fc)
        return new Task(definition, _task.scope ?? TaskScope.Workspace, test.goal,
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (test.builddir ? ['-C', test.builddir] : [])
                .concat(fc.buildConfig.makeArgs || [])
                .concat(["-esi",
                    "check",
                    "TEST_LOGS=" + test.goal
                ]), fc.currentTestEnvironment.testExecOptions),"$gcc");
	}
}

export class AutoToolsCheckTaskProvider implements MyTaskProvider {
	readonly myType = 'check';
    private checkAllTask: Task | undefined;

    private all: Map<vscode.WorkspaceFolder, Task[]> = new Map();

    constructor(private fc: FolderConfig) {}
	public provideTasks(): Thenable<Task[]> | undefined {
        let tasks : Task[] = [];
        this.all.forEach((v,k) => tasks.push(...v));
        return new Promise(r => tasks);
	}

    changeConfiguration() : void {
        this.all.delete(this.fc.folder);
    }

    public update() : boolean {
        let c = this.fc.buildConfig;
        var targets : Task[] = [];
        let e = this.fc.testEnvironments;
        let traceLiveTestRuns = configuration.gettraceLiveTestRuns();
        this.fc.buildTargets.forEach((goals, dir) => {
            const kind: CheckTask = {
                type: this.myType,
                folderIndex: this.fc.folder.index,
                builddir: dir
            };
            if (!env.dirs || env.dirs.includes(dir))
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Test_Suite)) {
                var newMap : Map<TestEnvironment, vscode.Task> = new Map();
                var newLiveMap : Map<TestEnvironment, vscode.Task> = new Map();
                g.task = newMap;
                g.livetask = newLiveMap;
                let envs = FilterEnvsByDir(e, dir);
                let ME_KEEP_ENV = KeepList(envs);

                envs.forEach((env) => {
                    var newTask = new Task(kind, TaskScope.Workspace, 'Run test suite ' + (dir ? ('in ' + dir) : 'at the top') + (' @ ' + env.name),
                        "autotools",
                    new ProcessExecution(
                        configuration.getMakePath(),
                        (dir ? ['-C', dir] : [])
                        .concat(c.makeArgs || [])
                        .concat(["-Res",
                            "me-check",
                            `ME_KEEP_ENV=${ME_KEEP_ENV}`,
                            "--eval=include Mergesium.rules"]),
                        env.checkExecOptions),"$gcc");
                    newTask.group = TaskGroup.Test;
                    newTask.detail = localize("automake.check", "$(checklist) Test Suite");
                    newTask.presentationOptions = defaultCheckPresentation;
                    newMap.set(env, newTask);
                    targets.push(newTask);

                    newTask = new Task(kind, TaskScope.Workspace, 'Update test suite ' + (dir ? ('log in ' + dir) : 'log at the top')  + (' @ ' + env.name),
                    "autotools",
                    new ProcessExecution(
                        traceLiveTestRuns ? extension.dryRunner : configuration.getMakePath(),
                        (dir ? ['-C', dir] : [])
                        .concat(c.makeArgs || [])
                        .concat(traceLiveTestRuns ? ["--trace", "--silent"] : [])
                        .concat(["-Res",
                            "test-suite.log",
                            `ME_KEEP_ENV=${ME_KEEP_ENV}`
                        ]),
                        env.updateExecOptions), "$gcc");
                    newTask.group = TaskGroup.Test;
                    newTask.presentationOptions = defaultCheckPresentation;
                    newTask.detail = localize("automake.livecheck", "$(checklist) $(broadcast) Test Suite Update");
                    newLiveMap.set(env, newTask);
                    targets.push(newTask);
                });

            }}});
        let checkAllTaskDef : CheckTask = {
            type: this.myType,
            folderIndex: this.fc.folder.index,
            builddir: ''
        };
        this.checkAllTask = new Task(checkAllTaskDef, TaskScope.Workspace, 'Run user test suite (make check)',
            "autotools",
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(c.makeArgs || [])
                .concat(["-Res",
                    "check"]),
                {
                    env: {
                        TESTS_ENVIRONMENT: ''
                    }
                }),"$gcc");
        this.checkAllTask.group = TaskGroup.Test;
        this.checkAllTask.presentationOptions = defaultCheckPresentation;
        this.checkAllTask.detail = localize("autotools.check.noenv", "$(checklist) Run full test suite without test environment");
        targets.push(this.checkAllTask);

        this.all.set(this.fc.folder, targets);
        return false;
    }

	public resolveTask(_task: Task): Task | undefined {
		const check = _task.definition.check;
        if (!check)
            return undefined;

        // resolveTask requires that the same definition object be used.
        const definition: TestTask = <any>_task.definition;
        let fc = configuration.findFolderConfigByIndex(definition.folderIndex);
        if (fc && definition.test) return new Task(definition, _task.scope ?? TaskScope.Workspace, "check",
            this.myType,
            new ProcessExecution(
                configuration.getMakePath(),
                (check.builddir ? ['-C', check.builddir] : [])
                .concat(fc.buildConfig.makeArgs || [])
                .concat(definition.test?.goal)
                .concat(check.TESTS ? 'TESTS=' +  check.TESTS.join(' ') : [])
                .concat(check.TEST_SUITE_LOG ? 'TEST_SUITE_LOG=' +  check.TEST_SUITE_LOG : []),
                fc.currentTestEnvironment.checkExecOptions));
	}
    public async checkAll() : Promise<void> {
        if (this.checkAllTask) {
            let isBusy: boolean = false;
            await this.fc.autotoolsTask.waitToTouchMakefiles();
            let reason = await vscode.tasks.executeTask(this.checkAllTask)
                .then(e => (isBusy = true) && "ok", (r) => r.message);
            if (!isBusy) {
                logger.message(`ERROR: Failed to start task ${this.checkAllTask.name}`, 'Normal');
                this.fc.autotoolsTask.autotoolsDoneNoResult();
            }
        }
    }
}

export interface MyTaskProvider extends TaskProvider {
    readonly myType: string;
    update(): boolean;
    changeConfiguration(): void;
}

export class AutoToolsBootstrapTaskProvider implements MyTaskProvider {
	readonly myType = 'autotools';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public bootstrapTask?: vscode.Task;
    public regenTask?: vscode.Task;
    public reautomakeTask?: vscode.Task;
    // public autoreconfTask?: vscode.Task;
    public recheckTask?: vscode.Task;
    public helpTask?: vscode.Task;
    private the_bootstrap_cmd : string[] | undefined;
    public onFinishedWork : vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
    private working: boolean = false;
    static manifests: string[] = [
            "configure.ac",
            "configure.in",
    ];
    constructor(private fc: FolderConfig) {
        const helpkind: AutotoolsTask = {
            type: this.myType,
            folderIndex: fc.folder.index,
            action: 'help'
        };
        this.helpTask = new Task(helpkind, TaskScope.Workspace,
            localize("autotools.configure.help.task", "Display package configuration options"),
            "Autotools task",
            new ProcessExecution("./configure", ["--help"]));
        this.helpTask.detail = localize("autotools.configure.help", "$(tools) Output package configuration options using 'configure --help'");
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
//        if (definition.action === 'autoreconf')
//            return this.autoreconfTask;
        if (definition.action === 'regen')
            return this.regenTask;
        if (definition.action === 'reautomake')
            return this.reautomakeTask;
        if (definition.action === 'help')
            return this.helpTask;
	}

    public bootstrap_cmd(): string[] | undefined {
        if (this.the_bootstrap_cmd)
            return this.the_bootstrap_cmd;
        if (!this.fc.isAutotoolsProject) {
            return undefined;
        } else {
            for (const script of boostrap_scripts) {
                let fullpath = path.join(this.fc.folder.uri.path, script);
                if (checkFileExistsSync(fullpath))
                    return [fullpath];
            }
        }
        return configuration.autoreconfCmd().concat('-i');
    }
    private isErroredConfiguration: boolean = false;
    public isConfigured(): boolean {
        return !this.isErroredConfiguration &&
            checkFileExistsSync(path.join(this.fc.abs_top_builddir, "config.status"));
    }

    changeConfiguration() : void
    {
        let c = this.fc.buildConfig;
        let b = this.bootstrap_cmd();
        if (b) {
            const kind: AutotoolsTask = {
                type: this.myType,
                folderIndex: this.fc.folder.index,
                action: 'bootstrap'
            };
            this.bootstrapTask = new Task(kind, TaskScope.Workspace,
                localize("autotools.bootstrap.task", "Bootstrap {0}", this.fc.folder.name),
                "Autotools task",
                new ProcessExecution(b[0], b.slice(1), { env: { ACLOCAL_PATH: extension.m4Path }}),
                ["autotools_configureac", "autotools_configure"]);
            this.bootstrapTask.group = TaskGroup.Build;
            this.bootstrapTask.detail = localize("autotools.bootstrap", "$(tools) Bootstrap project using '{0}'", b.join(' '));

            /* This is not used yet. Instead, make.configure will automatically update Makefile.inS */
            const automake_kind: AutotoolsTask = {
                type: this.myType,
                folderIndex: this.fc.folder.index,
                action: 'reautomake'
            };
            this.reautomakeTask = new Task(automake_kind, TaskScope.Workspace,
                localize("autotools.reautomakecmd.task", "Update Makefile.in and config headers"),
                "Autotools task",
                new ProcessExecution('automake', ['--no-force']));
            this.reautomakeTask.group = TaskGroup.Build;
            this.reautomakeTask.detail = localize("autotools.makefilein.update", "$(sync) Regenerate Makefile.in templates. See [Updating Makefile.inS](https://www.gnu.org/software/automake/manual/html_node/automake-Invocation.html#index-_002d_002dno_002dforce)");

            var autoreconf : string = configuration.autoreconfCmd().join(' ');

            this.regenTask = new Task({type: this.myType, action: 'regen', folderIndex: this.fc.folder.index},
                    TaskScope.Workspace, "Update Makefiles and config headers",
                localize("autotools.update.task", "Configuration output"),
                new ShellExecution(
                    (c.top_builddir ? `${autoreconf} -v && CDPATH= cd ${c.top_builddir} && ./config.status` :
                        `${autoreconf} -v && ./config.status`), { env: { ACLOCAL_PATH: extension.m4Path }}),
                            ["autotools_configureac", "autotools_configure"]);
            this.regenTask.group = TaskGroup.Build;
            this.regenTask.detail = localize("autotools.update", "$(sync) Regenerate Makefiles and headers. See [Autoconf output](https://www.gnu.org/software/autoconf/manual/autoconf-2.69/html_node/Output.html)");

            this.recheckTask = new Task({type: this.myType, action: 'recheck', folderIndex: this.fc.folder.index},
                TaskScope.Workspace, "Re-check configuration",
                localize("autotools.recheck.task", "Configuration update"),
                new ShellExecution('./config.status --recheck && ./config.status', {
                            env: { ACLOCAL_PATH: extension.m4Path },
                            cwd: this.fc.abs_top_builddir
                        }),
                        ["autotools_configureac", "autotools_configure"]);
            this.recheckTask.group = TaskGroup.Build;
            this.recheckTask.presentationOptions = presentSilent;
            this.recheckTask.detail = localize("autotools.recheck", "$(sync) Update configuration. See [config.status invocation - --recheck](https://www.gnu.org/software/autoconf/manual/autoconf-2.69/html_node/config_002estatus-Invocation.html)");

            this.myPromise = Promise.resolve([
                    this.bootstrapTask,
                    this.regenTask,
                    this.recheckTask
                ]);
        }
        else {
            telemetry.setSpanStatus(extension.journey, SpanStatusCode.ERROR, "no-bootstrap-task");
            this.myPromise = Promise.reject("Runtime error - no bootstrap task")
        }
    }
    update(): boolean {
        return false;
    }
    public async bootstrap(): Promise<vscode.TaskExecution> {
        if (this.bootstrapTask) {
            await this.waitToTouchMakefiles();
            return await vscode.tasks.executeTask(this.bootstrapTask).then((te: vscode.TaskExecution) => {
                ui.getUI().setLoading(ui.UIStatus.REGEN, this.fc);
                return te;
            },(e) => {
                ui.getUI().setLoading(ui.UIStatus.ERR, this.fc);
                return Promise.reject("Failed to start boostrap task");
            });
        }
        return Promise.reject("No boostrap task");
    }
    /* runs automake --no-force, then recheck.
     * This is quicker than bootstrapping + configure
     */
    public async reautomake(span: Span): Promise<void> {
        if (this.reautomakeTask && !this.isWorking) {
            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(this.reautomakeTask).then((e) => {
                ui.getUI().setLoading(ui.UIStatus.REGEN, this.fc);
                extension.running.set(e, span);
            });
        }
    }
    public async regen(): Promise<void> {
        // Use regenWorking to avoid restarting when already running.
        // Eg, Makefile.in is updated in the workspace, which triggers
        // a separate, unnecesary update.
        if (this.regenTask && !this.isWorking) {
            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(this.regenTask).then((e) => {
                ui.getUI().setLoading(ui.UIStatus.REGEN, this.fc);
                extension.running.set(e, telemetry.startSpan("regen", extension.journey));
            });
        }
    }
    public async recheck(span: Span): Promise<void> {
        // Use regenWorking to avoid restarting when already running.
        // Eg, Makefile.in is updated in the workspace, which triggers
        // a separate, unnecesary update.
        if (this.recheckTask) {
            await this.waitToTouchMakefiles();
            await this.fc.readPkgInfo();
            vscode.tasks.executeTask(this.recheckTask).then((e) => {
                ui.getUI().setLoading(ui.UIStatus.REGEN, this.fc);
                extension.running.set(e, span);
            });
        }
    }
    public async help(): Promise<void> {
        if (this.helpTask) {
            await vscode.tasks.executeTask(this.helpTask);
        }
    }
    public async configure(span: Span): Promise<boolean> {
        let c = this.fc.buildConfig;
        let success = false;

        const configurekind: AutotoolsTask = {
            type: this.myType,
            folderIndex: this.fc.folder.index,
            action: 'configure'
        };
        let destdir = this.fc.abs_top_builddir;
        try {
            if (this.fc.buildConfig.top_builddir)
                createDirectorySync(destdir);

            let configureArgs = c.configureArgs || [];
            let task = new Task(configurekind, TaskScope.Workspace,
                localize("autotools.configure.task", "Prepare build directory"),
                "Autotools task",
                new ProcessExecution(path.join(this.fc.folder.uri.path, 'configure'), configureArgs,
                    {cwd : destdir}),
                    ['autotools_configureac', 'autotools_configure']);
            task.detail = localize("automake.configure.help", "$(tools) Configure build directory");

            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(task)
                .then((e) => {
                    extension.running.set(e, span);
                    !e.task.execution && this.autotoolsDoneNoResult();
            }, (err) => {
                telemetry.setSpanStatus(span, SpanStatusCode.ERROR, err);
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
    public async waitToTouchMakefiles() : Promise<void> {
        return new Promise(resolve => {
            if (this.working) {
                let disp = this.onFinishedWork.event(e => {
                    if (!this.working) {
                        this.working = true;
                        return (!e) && (disp.dispose() ?? true) && resolve();
                    }
                });
            } else { this.working = true; return resolve();}});
    }
    public autotoolsDoneNoResult(): void {
        this.working = false; // This could be false already if the user runs the task from palette
        this.onFinishedWork.fire(false);
    }
    public get isWorking() : boolean {
        return this.working;
    }
    public async autotoolsDone(span: Span, task: ProcessExecution | ShellExecution | vscode.CustomExecution | undefined, exitCode: number): Promise<void> {
        if (exitCode != 0) {
            var kbUrl : vscode.Uri = await this.fc.kbUrl();
            if (task == this.bootstrapTask?.execution) {
                logger.message(localize('autotools.regen.failed', '{0}: ERROR: Bootstrap failed. Review the Terminal tab for cause.',
                    getStartTime(span).toISOString()), "Normal");
                logger.message('Bootstrapping can be re-attempted with "Autotools: Bootstrap"', "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#bootstrap-fail', "Normal");
                // logger.showOutputChannel();
            }
            else if (task == this.regenTask?.execution) {
                logger.message(localize('autotools.regen.failed', '{0}: ERROR: Regen failed. Review the Terminal tab for cause.',
                    getStartTime(span).toISOString()), "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#regen-fail', "Normal");
                // logger.showOutputChannel();
            }
            else if (task == this.recheckTask?.execution) {
                logger.message(localize('autotools.recheck.failed', '{0}: ERROR: Recheck failed. Review the Terminal tab for cause.',
                    getStartTime(span).toISOString()), "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#recheck-fail', "Normal");
                // logger.showOutputChannel();
            }
        }
        if (this.working)
            this.isErroredConfiguration = (exitCode != 0);
    }
}

// These two filters can be precalculated and stored in a Map<dir,{envlist,keeplist}>
// They are only executed twice. Once for check tasks and once for test tasks, ie,
// only when makefiles or settings change.
// calling them repeatedly to save memory at expense of time
function FilterEnvsByDir(e: TestEnvironment[], dir: string) : TestEnvironment[] {
    return e.filter(i => !i.dirs || i.dirs.includes(dir));
}
function KeepList(e: TestEnvironment[]) : string {
    return e.map(i => i.hashCode.toString(36)).join(',');
}
export interface BuildTask {
    /*
     * The makefile goal that this task operates on
     */
    readonly type: string;
    target?: BuildTarget;
    
    folderIndex: number;
};

export interface TestTask {
    /*
     * The test output log this task creates.
     */
    readonly type: string;
    test?: BuildTarget;
    folderIndex: number;
};

export interface CheckTask {
    /*
     * Test suite arguments (default: none, ie, run 'make check' )
     */
    readonly type: string;
    check?: CheckTarget;
    folderIndex: number;
    builddir: string;
};

export class CheckTarget {
    TESTS?: string[];
    TEST_SUITE_LOG?: string;
}

export interface AutotoolsTask {
    readonly type: string;
    action: string;
    folderIndex: number;
};
