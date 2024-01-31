/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import * as cp from 'child_process';
import { Task, TaskDefinition, TaskScope, TaskGroup, TaskProvider,
    ProcessExecution, ShellExecution,
    workspace } from 'vscode';
import { Goal } from './parser/gnumake';
import { assert, error } from 'console';
import * as configuration from './configuration';
import { TestEnvironment } from './configuration';
import { BuildTarget, t_all, t_none, readTRS, TRS, isSuspect } from './make';
import { resolvePathToRoot, checkFileExistsSync, createDirectorySync } from './util';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { Script } from 'vm';
import { extension } from './extension';
import * as util from './util';
import * as make from './make';
import * as logger from './logger';
import { env } from 'process';
import * as ui from './ui';
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


export class AutoToolsBuildTaskProvider implements MyTaskProvider {
	readonly myType = 'build';
	private myPromise: Thenable<Task[]> | undefined = undefined;

	public provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    public update(disposables: vscode.Disposable[]) {
        let c = configuration.getCurrentMakefileConfiguration();
        this.changeConfiguration(c, disposables);
    }
    changeConfiguration(c: configuration.MakefileConfiguration, disposables: vscode.Disposable[]) {
        var targets: Task[] = [];
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
        let c = configuration.getCurrentMakefileConfiguration();
        this.changeConfiguration(c, disposables);
    }
    changeConfiguration(c: configuration.MakefileConfiguration, disposables: vscode.Disposable[]) {
        var targets: Task[] = [];
        this.numFails = 0;
        this.numTests = 0;
        this.numUnknown = 0;
        this.numSuspect = 0;
        let tc = extension.testController;
        let t = configuration.getAllBuildTargets();
        let cte = configuration.getCurrentTestEnvironment();
        let e = make.supportsTestEnvironments() ? configuration.getTestEnvironments() : [cte];
        t.forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & Goal.Flags.Test_Suite) {
                    g.test || tc?.addSuite(c, dir, g);
                    if (g.goal && g.depends) {
                        let p : string = util.resolvePathToRoot(path.join(c.top_builddir, dir));
                        disposables.push(new util.MyFileWatcher(p, (e, f) => {
                            if (f.endsWith(".trs"))
                                extension.trsChange(c, cte, vscode.Uri.file(path.join(p,f)));
                        }));
                        let envs = FilterEnvsByDir(e, dir);
                        let ME_KEEP_ENV = KeepList(envs);
                        g.depends.forEach((d) => {
                            if(!d.goal)
                                throw new Error("Invalid test.depends");
                            let dgoal : string = d.goal;
                            let test = new BuildTarget(dir, dgoal);
                            const kind: TestTask = {
                                type: this.myType,
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
                                    (c.top_builddir ? ['-C', c.top_builddir] : [])
                                    .concat(dir ? ['-C', dir] : [])
                                    .concat(c.makeArgs || [])
                                    .concat(["-Resi",
                                        "me-check",
                                        `ME_KEEP_ENV=${ME_KEEP_ENV}`,
                                        "--eval=include Mergesium.rules",
                                        "TEST_LOGS=" + test.goal
                                    ]), env.testExecOptions), );
                                newTask.group = TaskGroup.Test;
                                newTask.detail = localize("automake.test", "$(check) Run test '{0}'", path.basename(dgoal, ".log"));
                                newTask.presentationOptions = presentSilent;
                                newMap.set(env, newTask);
                                targets.push(newTask);
                            });

                            /* Read existing TRS file to show correct last known status in the outline */
                            d.trs = readTRS(test, c);
                            let current : TRS = d.trs.results.get(cte.hashCode) ?? TRS.NONE;
                            this.numFails += (current == TRS.FAIL ? 1 : 0);
                            this.numUnknown += ((current == TRS.NONE || current == TRS.ERROR) ? 1 : 0);
                            this.numSuspect += (isSuspect(current) ? 1 : 0);
                            this.numTests++;

                            // tc.addTest(suite, d, trs);
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
                ]), configuration.getCurrentTestEnvironment().testExecOptions));
	}
}

export class AutoToolsCheckTaskProvider implements MyTaskProvider {
	readonly myType = 'check';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    private checkAllTask: Task | undefined;

    provideTasks(): Thenable<Task[]> | undefined {
		return this.myPromise;
	}

    update(disposables: vscode.Disposable[]) {

        let c = configuration.getCurrentMakefileConfiguration();
        this.changeConfiguration(c, disposables);
    }
    changeConfiguration(c: configuration.MakefileConfiguration, disposables: vscode.Disposable[]) {
        var targets : Task[] = [];
        let e = make.supportsTestEnvironments() ? configuration.getTestEnvironments() : [];
        var cte = configuration.getCurrentTestEnvironment();
        configuration.getAllBuildTargets().forEach((goals, dir) => {
            const kind: CheckTask = {
                type: this.myType,
                builddir: dir
            };
            if (!env.dirs || env.dirs.includes(dir))
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Test_Suite)) {
                var newMap : Map<TestEnvironment, vscode.Task> = new Map();
                g.task = newMap;
                let envs = FilterEnvsByDir(e, dir);
                let ME_KEEP_ENV = KeepList(envs);

                envs.forEach((env) => {
                    var newTask = new Task(kind, TaskScope.Workspace, 'Run test suite ' + (dir ? ('in ' + dir) : 'at the top') + (' @ ' + env.name),
                        "autotools",
                    new ProcessExecution(
                        configuration.getMakePath(),
                        (c.top_builddir ? ['-C', c.top_builddir] : [])
                        .concat(dir ? ['-C', dir] : [])
                        .concat(c.makeArgs || [])
                        .concat(["-Resi",
                            "me-check",
                            `ME_KEEP_ENV=${ME_KEEP_ENV}`,
                            "--eval=include Mergesium.rules"]),
                        env.checkExecOptions));
                    newTask.group = TaskGroup.Test;
                    newTask.detail = localize("automake.check", "$(checklist) Test Suite");
                    newTask.presentationOptions = defaultCheckPresentation;
                    newMap.set(env, newTask);
                    targets.push(newTask);
                });
                let traceLiveTestRuns = configuration.gettraceLiveTestRuns();
                g.livetask = new Task(kind, TaskScope.Workspace, 'Update test suite ' + (dir ? ('log in ' + dir) : 'log at the top')  + (' @ ' + cte.name),
                    "autotools",
                    new ProcessExecution(
                        traceLiveTestRuns ? extension.dryRunner : configuration.getMakePath(),
                        (c.top_builddir ? ['-C', c.top_builddir] : [])
                        .concat(dir ? ['-C', dir] : [])
                        .concat(c.makeArgs || [])
                        .concat(traceLiveTestRuns ? ["--trace", "--silent"] : [])
                        .concat(["-Resi",
                            "test-suite.log",
                            `ME_KEEP_ENV=${ME_KEEP_ENV}`
                        ]),
                        cte.updateExecOptions));
                g.livetask.group = TaskGroup.Test;
                g.livetask.presentationOptions = defaultCheckPresentation;
                g.livetask.detail = localize("automake.livecheck", "$(checklist) $(broadcast) Test Suite Update");
                targets.push(g.livetask);

            }}});
        this.checkAllTask = new Task({
                type: this.myType,
                builddir: ''}, TaskScope.Workspace, 'Run user test suite (make check)',
            "autotools",
            new ProcessExecution(
                configuration.getMakePath(),
                (c.top_builddir ? ['-C', c.top_builddir] : [])
                .concat(c.makeArgs || [])
                .concat(["-Resi",
                    "check"]),
                {
                    env: {
                        TESTS_ENVIRONMENT: ''
                    }
                }));
        this.checkAllTask.group = TaskGroup.Test;
        this.checkAllTask.presentationOptions = defaultCheckPresentation;
        this.checkAllTask.detail = localize("autotools.check.noenv", "$(checklist) Run full test suite without test environment");
        targets.push(this.checkAllTask);

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
                .concat(check.TEST_SUITE_LOG ? 'TEST_SUITE_LOG=' +  check.TEST_SUITE_LOG : []),
                configuration.getCurrentTestEnvironment().checkExecOptions));
	}
    public async checkAll() : Promise<void> {
        if (this.checkAllTask) {
            let isBusy: boolean = false;
            await extension.waitToTouchMakefiles();
            let reason = await vscode.tasks.executeTask(this.checkAllTask)
                .then(e => (isBusy = true) && "ok", (r) => r.message);
            if (!isBusy) {
                logger.message(`ERROR: Failed to start task ${this.checkAllTask.name}`, 'Normal');
                extension.autotoolsDoneNoResult();
            }
        }
    }
}

export interface MyTaskProvider extends TaskProvider {
    readonly myType: string;
    update(disposables: vscode.Disposable[]): void;
    changeConfiguration(c: configuration.MakefileConfiguration, disposables: vscode.Disposable[]): void;
}

export class AutoToolsBootstrapTaskProvider implements MyTaskProvider {
	readonly myType = 'autotools';
	private myPromise: Thenable<Task[]> | undefined = undefined;
    public bootstrapTask?: vscode.Task;
    public regenTask?: vscode.Task;
    public recheckTask?: vscode.Task;
    public helpTask?: vscode.Task;
    private the_bootstrap_cmd : string[] | undefined;
    public onFinishedWork : vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
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
            this.bootstrapTask = new Task(kind, TaskScope.Workspace,
                localize("autotools.bootstrap.task", "Bootstrap autotools"),
                "Autotools task",
                new ProcessExecution(b[0], b.slice(1)));
            this.bootstrapTask.group = TaskGroup.Build;
            this.bootstrapTask.detail = localize("autotools.bootstrap", "$(tools) Bootstrap project using '{0}'", b.join(' '));

            const helpkind: AutotoolsTask = {
                type: this.myType,
                action: 'help'
            };
            this.helpTask = new Task(helpkind, TaskScope.Workspace,
                localize("autotools.configure.help.task", "Display package configuration options"),
                "Autotools task",
                new ProcessExecution("./configure", ["--help"]));
            this.helpTask.detail = localize("autotools.configure.help", "$(tools) Output package configuration options using 'configure --help'");
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
        if (this.the_bootstrap_cmd)
            return this.the_bootstrap_cmd;
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
        }
        return configuration.autoreconfCmd().concat('-i');
    }
    public isBootstrapped(): boolean {
        return checkFileExistsSync(resolvePathToRoot("configure"));
    }
    private isErroredConfiguration: boolean = false;
    public isConfigured(c: configuration.MakefileConfiguration): boolean {
        return !this.isErroredConfiguration &&
            checkFileExistsSync(resolvePathToRoot(path.join(c.top_builddir, "config.status")));
    }
    update(disposables: vscode.Disposable[]): void {
    }
    changeConfiguration(c: configuration.MakefileConfiguration, disposables: vscode.Disposable[])
    {
        if (this.bootstrapTask) {
            var autoreconf : string = configuration.autoreconfCmd().join(' ');

            this.regenTask = new Task({type: this.myType, action: 'regen'},
                    TaskScope.Workspace, "Update Makefiles and config headers",
                localize("autotools.update.task", "Configuration output"),
                new ShellExecution(
                    c.top_builddir ? `${autoreconf} -v && CDPATH= cd ${c.top_builddir} && ./config.status` :
                        `${autoreconf} -v && ./config.status`));
            this.regenTask.group = TaskGroup.Build;
            this.regenTask.detail = localize("autotools.update", "$(sync) Regenerate Makefiles and headers. See [Autoconf output](https://www.gnu.org/software/autoconf/manual/autoconf-2.69/html_node/Output.html)");

            this.recheckTask = new Task({type: this.myType, action: 'recheck'},
                TaskScope.Workspace, "Re-check configuration",
                localize("autotools.recheck.task", "Configuration update"),
                new ShellExecution(
                    c.top_builddir ? `${autoreconf} && CDPATH= cd ${c.top_builddir} && ./config.status --recheck && ./config.status` :
                        `${autoreconf} && ./config.status --recheck && ./config.status`));
            this.recheckTask.group = TaskGroup.Build;
            this.recheckTask.presentationOptions = presentSilent;
            this.recheckTask.detail = localize("autotools.recheck", "$(sync) Update configuration. See [config.status invocation - --recheck](https://www.gnu.org/software/autoconf/manual/autoconf-2.69/html_node/config_002estatus-Invocation.html)");

            this.myPromise = Promise.resolve([this.regenTask]
                .concat(this.bootstrapTask ?? []));
                this.myPromise = Promise.resolve([
                    this.bootstrapTask,
                    this.regenTask,
                    this.recheckTask
                ]);
        }
    }
    public async bootstrap(): Promise<void> {
        if (this.bootstrapTask) {
            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(this.bootstrapTask).then(() => {
                ui.getUI().setLoading(ui.UIStatus.LOADING);
            });
        }
    }
    public async regen(): Promise<void> {
        // Use regenWorking to avoid restarting when already running.
        // Eg, Makefile.in is updated in the workspace, which triggers
        // a separate, unnecesary update.
        if (this.regenTask) {
            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(this.regenTask).then(() => {
                ui.getUI().setLoading(ui.UIStatus.REGEN);
            });
        }
    }
    public async recheck(): Promise<void> {
        // Use regenWorking to avoid restarting when already running.
        // Eg, Makefile.in is updated in the workspace, which triggers
        // a separate, unnecesary update.
        if (this.recheckTask) {
            await this.waitToTouchMakefiles();
            await extension.readPkgInfo();
            vscode.tasks.executeTask(this.recheckTask).then(() => {
                ui.getUI().setLoading(ui.UIStatus.REGEN);
            });
        }
    }
    public async help(): Promise<void> {
        if (this.helpTask) {
            await vscode.tasks.executeTask(this.helpTask);
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

            let configureArgs = c.configureArgs || [];
            configureArgs.push(configuration.getdisableMaintainerMode() ? '--disable-maintainer-mode' : '');
            let task = new Task(configurekind, TaskScope.Workspace,
                localize("autotools.configure.task", "Prepare build directory"),
                "Autotools task",
                new ProcessExecution(resolvePathToRoot("configure"), configureArgs,
                    {cwd : destdir}));
            task.detail = localize("automake.configure.help", "$(tools) Configure build directory");

            await this.waitToTouchMakefiles();
            vscode.tasks.executeTask(task)
                .then((e) => {
                    !e.task.execution && this.autotoolsDoneNoResult();
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
    public async autotoolsDone(task: ProcessExecution | ShellExecution | vscode.CustomExecution | undefined, exitCode: number): Promise<void> {
        if (exitCode != 0) {
            var kbUrl : vscode.Uri = await extension.kbUrl();
            if (task == this.bootstrapTask?.execution) {
                logger.message('Bootstrap failed. Review the Terminal tab for cause.', "Normal");
                logger.message('Bootstrapping can be re-attempted with "Autotools: Bootstrap"', "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#bootstrap-fail', "Normal");
                logger.showOutputChannel();
            }
            else if (task == this.regenTask?.execution) {
                logger.message('Regen failed. Review the Terminal tab for cause.', "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#regen-fail', "Normal");
                logger.showOutputChannel();
            }
            else if (task == this.recheckTask?.execution) {
                logger.message('Recheck failed. Review the Terminal tab for cause.', "Normal");
                logger.message('KB: ' + kbUrl.toString(true) + '#recheck-fail', "Normal");
                logger.showOutputChannel();
            }
        }
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
