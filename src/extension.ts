// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Makefile Tools extension

import * as configuration from './configuration';
import * as cpptools from './cpptools';
import * as fs from 'fs';
import * as logger from './logger';
import * as make from './make';
import * as toolParser from './parser/tool';
import * as gnumake from './parser/gnumake';
import { Goal } from './parser/gnumake';
import * as path from 'path';
import * as state from './state';
import * as telemetry from './telemetry';
import * as tree from './tree';
import * as ui from './ui';
import { resolvePathToRoot } from './util';
import * as vscode from 'vscode';
import * as cpp from 'vscode-cpptools';
import { AutoToolsBuildTaskProvider,
        AutoToolsTestTaskProvider,
        AutoToolsCheckTaskProvider,
        AutoToolsBootstrapTaskProvider,
        AutotoolsTask,
        BuildTask,
        TestTask,
        MyTaskProvider } from './tasks';
import { SuiteDecorations } from './suite-decorator';

import * as nls from 'vscode-nls';
import { assert } from 'console';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

let statusBar: ui.UI = ui.getUI();

export let extension: Extension;

export class Extension {
    static readonly whoami: string = "mergesium.autotools";

    private mementoState = new state.StateManager(this.extensionContext);
    public readonly _projectOutlineProvider = new tree.ProjectOutlineProvider(this.mementoState.buildConfiguration || 'Default');
    private _projectOutlineTreeView : vscode.TreeView<tree.Node> | undefined;
    public readonly suiteDecorator = new SuiteDecorations();

    private readonly cppConfigurationProvider = new cpptools.CppConfigurationProvider();
    public getCppConfigurationProvider(): cpptools.CppConfigurationProvider { return this.cppConfigurationProvider; }

    private cppToolsAPI?: cpp.CppToolsApi;
    private cppConfigurationProviderRegister?: Promise<void>;
    private tasks: MyTaskProvider[];
    private autotoolsTask: AutoToolsBootstrapTaskProvider;
    private buildTasks: AutoToolsBuildTaskProvider;
    private testTasks: AutoToolsTestTaskProvider;
    private needTaskFetchBugWorkaround: boolean = true;
    private compilerFullPath ?: string;
    public readonly dryRunner : string;

    public constructor(public readonly extensionContext: vscode.ExtensionContext) {
        this.autotoolsTask = new AutoToolsBootstrapTaskProvider();
        this.buildTasks = new AutoToolsBuildTaskProvider();
        this.testTasks = new AutoToolsTestTaskProvider();
        this.tasks = [
            this.autotoolsTask,
            this.buildTasks,
            this.testTasks,
            new AutoToolsCheckTaskProvider(),
        ];
        this.dryRunner = path.join(extensionContext.extensionPath, "bin/make" + (process.platform === 'win32' ? ".exe" : ""));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.bootstrap', async () => {
            await this.autotoolsTask.bootstrap();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.regen', async () => {
            await this.autotoolsTask.regen();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.configure.help', async () => {
            await this.autotoolsTask.help();
        }));
    }
    public createPanel(extensionContext: vscode.ExtensionContext) : void {
        this._projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
            treeDataProvider: this._projectOutlineProvider,
            showCollapseAll: false

        });
        extensionContext.subscriptions.push(this._projectOutlineTreeView.onDidChangeSelection((e) => {
            if (e.selection.length > 0) {
                let selected = e.selection[0];
                if (selected instanceof tree.Node && !(selected instanceof tree.SubNode)) {
                    return openLog(selected);
                }
            }
        }));
        this._projectOutlineTreeView.description = "outline description";
        // this._projectOutlineTreeView.message = "outline message";
//        this._projectOutlineTreeView.badge = {tooltip: '🧰', value: 42};
//        this._projectOutlineTreeView.badge = {tooltip: '🧰', value: 42};
    }

    failStatUpdate(oldresult: make.TRS, result: make.TRS) {
        assert(oldresult != result);
        if ((result == make.TRS.NONE || result == make.TRS.ERROR) &&
            !(oldresult == make.TRS.NONE || oldresult == make.TRS.ERROR))
            this.testTasks.numUnknown++;
        else if ((oldresult == make.TRS.NONE || oldresult == make.TRS.ERROR) &&
                !(result == make.TRS.NONE || result == make.TRS.ERROR))
            this.testTasks.numUnknown--;

        if (oldresult == make.TRS.FAIL)
            this.testTasks.numFails--;
        else if (result == make.TRS.FAIL)
            this.testTasks.numFails++;

        if (make.isSuspect(oldresult))
            this.testTasks.numSuspect--;
        else if (make.isSuspect(result))
            this.testTasks.numSuspect++;
    }

    trsChange(c: configuration.MakefileConfiguration, uri: vscode.Uri) : void {
        if (!c.top_builddir)
            return;

        let dir = path.relative(c.top_builddir, path.dirname(uri.path));
        let log = path.basename(uri.path, ".trs") + ".log";
        let goal = configuration.getAllBuildTargets()
            ?.get(dir)
            ?.get('test-suite.log')
            ?.depends?.find((d) => d.goal === log);

        if (goal) {
            let oldresult = goal.flags & Goal.Flags.Test_Result_Mask;
            let result = make.readTRS(new make.BuildTarget(dir, log));
            if (oldresult != result) {
                goal.flags &= ~Goal.Flags.Test_Result_Mask;
                goal.flags |= result;
                this.suiteDecorator.update(vscode.Uri.from(
                    {authority: Extension.whoami, scheme: 'test', path: '/' + dir, query: log}));
                this.suiteDecorator.update(vscode.Uri.from(
                    {authority: Extension.whoami, scheme: 'check', path: '/' + dir, query: 'test-suite.log'}));
                this.failStatUpdate(oldresult, result);
                this.updateOutlineBadge();
            }
        }
    }


    public registerTasks(): void {
        // FIXME: Implement Disposable
        this.tasks.forEach((provider) => vscode.tasks.registerTaskProvider(provider.myType, provider));
        // It's possible that the fileWatcher takes too many descriptors, so
        // it might be replaced with waiting for exit codes.
        // Monitoring exit codes is blind to the user manually doing "make clean" or "make check"
        vscode.tasks.onDidEndTaskProcess((e) => {
            let task = e.execution.task;
            if (task) {
                const definition: TestTask = <any>task.definition;
                if (definition.type == "test:-standby-code" && definition.test) {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.test.builddir)
                        ?.get('test-suite.log');
                    if (suite) {
                        let goal = suite.depends?.find((d) => d.goal === definition.test?.goal);
                        if (goal) {
                            let result : make.TRS;
                            if (e.exitCode) {
                                // Test did not run
                                result = make.TRS.ERROR;
                            } else {
                                result = make.readTRS(definition.test);
                            }
                            let oldresult = goal.flags & Goal.Flags.Test_Result_Mask;
                            if (result != oldresult) {
                                goal.flags &= ~Goal.Flags.Test_Result_Mask;
                                goal.flags |= result;
                                this.suiteDecorator.update(vscode.Uri.from(
                                    {authority: Extension.whoami, scheme: 'test', path: '/' + definition.test.builddir, query: definition.test.goal}));
                                this.suiteDecorator.update(vscode.Uri.from(
                                    {authority: Extension.whoami, scheme: 'check', path: '/' + definition.test.builddir, query: 'test-suite.log'}));
                                this.failStatUpdate(oldresult, result);
                                this.updateOutlineBadge();
                            }
                        }
                    }
                } else if (definition.type == "check:-standby-code" && definition.builddir) {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.builddir)
                        ?.get('test-suite.log');
                    let hasUpdates = false;
                    if (suite) {
                        let result: make.TRS = e.exitCode ? make.TRS.FAIL : make.TRS.PASS;
                        if (result != (suite.flags & Goal.Flags.Test_Result_Mask)) {
                            suite.flags &= ~Goal.Flags.Test_Result_Mask;
                            suite.flags |= result;
                            this.suiteDecorator.update(vscode.Uri.from(
                                {authority: Extension.whoami, scheme: 'check', path: '/' + definition.builddir, query: suite.goal}));
                        }
                        if (suite.depends)
                        for (let test of suite.depends) {
                            if (test.task) {
                                result = make.readTRS(test.task.definition.test);
                                let oldresult = test.flags & Goal.Flags.Test_Result_Mask;
                                if (result != oldresult) {
                                    test.flags &= ~Goal.Flags.Test_Result_Mask;
                                    test.flags |= result;
                                    this.suiteDecorator.update(vscode.Uri.from(
                                        {authority: Extension.whoami, scheme: 'test', path: '/' + definition.builddir, query: test.goal}));
                                    hasUpdates = true;
                                    this.failStatUpdate(oldresult, result);
                                }
                            }
                        }
                        if (hasUpdates) this.updateOutlineBadge();
                    }
                } else if (definition.type == "autotools") {
                    const definition: AutotoolsTask = <any>task.definition;
                    if (definition?.action == "regen" || definition?.action == "recheck")
                        this.autotoolsTask.autotoolsDone();
                        ui.getUI().setStatus(e.exitCode ? ui.UIStatus.ERR : ui.UIStatus.OK);
                        if (!e.exitCode) {
                            make.configure(make.TriggeredBy.configureAfterConfigurationChange);
                        }
                }
            }
        });

        if (!this.autotoolsTask.isBootstrapped()) {
            let cmd = this.autotoolsTask.bootstrap_cmd();
            if (cmd) {
                const doit: string = localize("autotools.bootstrap.me", "Bootstrap");
                vscode.window.showErrorMessage(
                    localize("autotools.want.bootstrap", "The project needs to be bootstrapped ('{0}').", cmd.join(' ')),
                    doit,
                    localize("autotools.cancel", "Cancel")).then((value) => {
                    if (value === doit) {
                        this.autotoolsTask.bootstrap();
                    }
                });
            }
        }

        if (this.needTaskFetchBugWorkaround) {
            // FIXME: This is a workaround for vscode not parsing tasks.json prior to fetchTasks()
            const kind:BuildTask = {
                type: "build",
                target: new make.BuildTarget(".", "fetchTasks-bug-workaround")
            };
            vscode.tasks.executeTask(new vscode.Task(kind, vscode.TaskScope.Workspace, 'autotools', 'autotools',
                new vscode.ProcessExecution("true", ["this-is-a-workaround-for-fetchTasks-bug-not-parsing-tasks-json"])));
        }
    }
    updateOutlineBadge() : void {
        if (!this._projectOutlineTreeView) {
            return;
        }
        if (this.testTasks.numFails) {
            this._projectOutlineTreeView.badge =
                {tooltip:
                    localize("autotools.failing.tests", "{0}/{1} tests FAIL",
                        this.testTasks.numFails, this.testTasks.numTests),
                value: this.testTasks.numFails};
        } else if (this.testTasks.numSuspect) {
            this._projectOutlineTreeView.badge =
                {tooltip:
                    localize("autotools.suspect.tests", "{0}/{1} tests are suspect (XPASS/XFAIL/ERROR)",
                        this.testTasks.numSuspect, this.testTasks.numTests),
                value: this.testTasks.numSuspect};
        } else if (this.testTasks.numTests && this.testTasks.numUnknown) {
            this._projectOutlineTreeView.badge =
                {tooltip:
                    localize("autotools.unknown.tests", "{0}/{1} tests are available/not yet run",
                        this.testTasks.numUnknown, this.testTasks.numTests),
                value: this.testTasks.numUnknown};
        } else {
            this._projectOutlineTreeView.badge =
                {tooltip:
                    localize("autotools.no.tests", "No tests available"),
                value: 0
            };
        }
    }

    private configDisposables : vscode.Disposable[] = [];
    public updateTasks(build_tree: gnumake.Make): void {
        this.configDisposables.forEach((d) => d.dispose());
        this.tasks.forEach((provider) => provider.update(this.configDisposables));
        if (this._projectOutlineTreeView) {
            this._projectOutlineProvider.updateTargets(build_tree);
            this._projectOutlineTreeView.reveal(this._projectOutlineProvider.getChildren(undefined)[0],
                { select: false, focus: false, expand: true, } );
            this.updateOutlineBadge();
        }
    }
    public onConfigurationSelect(c: configuration.MakefileConfiguration) : void {
        this.tasks.forEach((provider) => provider.changeConfiguration(c, this.configDisposables));
    }
    public bootstrap(): void { this.autotoolsTask.bootstrap(); }
    // config.status (just re-output)
    public regen(): void { this.autotoolsTask.regen(); }
    // config.status --recheck
    public recheck(): void { this.autotoolsTask.recheck(); }
    public build(target: make.BuildTarget): void { this.buildTasks.build(target); }
    public async configure(): Promise<boolean> {
        this.needTaskFetchBugWorkaround = false;
        return await this.autotoolsTask.configure();
    };
    public isBootstrapped(): boolean { return this.autotoolsTask.isBootstrapped(); }

    public updateMakefileFilePresent(newValue: boolean): void {
        vscode.commands.executeCommand("setContext", "autotools.makefileFilePresent", newValue);
    }

    public getState(): state.StateManager { return this.mementoState; }

    public dispose(): void {
        this._projectOutlineTreeView?.dispose();
        if (this.cppToolsAPI) {
            this.cppToolsAPI.dispose();
        }
    }

    private fullFeatureSet: boolean = false;
    public getFullFeatureSet(): boolean { return this.fullFeatureSet; }
    public async setFullFeatureSet(newValue: boolean): Promise<void> {
        await vscode.commands.executeCommand('setContext', "autotools:fullFeatureSet", newValue);
        this.fullFeatureSet = newValue;
    }

    // Used for calling cppToolsAPI.notifyReady only once in a VSCode session.
    private ranNotifyReadyInSession: boolean = false;
    public getRanNotifyReadyInSession() : boolean { return this.ranNotifyReadyInSession; }
    public setRanNotifyReadyInSession(ran: boolean) : void { this.ranNotifyReadyInSession = ran; }

    // Similar to state.ranConfigureInCodebaseLifetime, but at the scope of a VSCode session
    private completedConfigureInSession: boolean = false;
    public getCompletedConfigureInSession() : boolean | undefined { return this.completedConfigureInSession; }
    public setCompletedConfigureInSession(completed: boolean) : void { this.completedConfigureInSession = completed; }

    // Register this extension as a new provider or request an update
    public async registerCppToolsProvider(): Promise<void> {
        await this.ensureCppToolsProviderRegistered();

        // Call notifyReady earlier than when the provider is updated,
        // as soon as we know that we are going to actually parse for IntelliSense.
        // This allows CppTools to ask earlier about source files in use
        // and Makefile Tools may return a targeted source file configuration
        // if it was already computed in our internal arrays (make.ts: customConfigProviderItems).
        // If the requested file isn't yet processed, it will get updated when configure is finished.
        // TODO: remember all requests that are coming and send an update as soon as we detect
        // any of them being pushed into make.customConfigProviderItems.
        if (this.cppToolsAPI) {
            if (!this.ranNotifyReadyInSession && this.cppToolsAPI.notifyReady) {
                // FIXME: not ready yet.
                this.cppToolsAPI.notifyReady(this.cppConfigurationProvider);
                this.setRanNotifyReadyInSession(true);
            }
        }
    }

    // Clear cached config data
    public resetCppToolsProvider(): void {
        let cache = this.cppConfigurationProvider.getCustomConfigurationProvider();
        cache.fileIndex.clear();
        cache.workspaceBrowse = {
            browsePath: [],
            compilerArgs: [],
            compilerPath: undefined,
            standard: undefined,
            windowsSdkVersion: undefined
        };
        this.cppConfigurationProvider.setCustomConfigurationProvider(cache);
        // workspaceBrowseConfiguration
        // this.updateCppToolsProvider();
    }

    // Request a custom config provider update.
    public updateCppToolsProvider(): void {
        this.cppConfigurationProvider.logConfigurationProviderBrowse();

        if (this.cppToolsAPI) {
            this.cppToolsAPI.didChangeCustomConfiguration(this.cppConfigurationProvider);
        }
    }

    public ensureCppToolsProviderRegistered(): Promise<void> {
        // make sure this extension is registered as provider only once
        if (!this.cppConfigurationProviderRegister) {
            this.cppConfigurationProviderRegister = this.registerCppTools();
        }

        return this.cppConfigurationProviderRegister;
    }

    public getCppToolsVersion(): cpp.Version | undefined {
        return this.cppToolsAPI?.getVersion();
    }

    public async registerCppTools(): Promise<void> {
        if (!this.cppToolsAPI) {
            this.cppToolsAPI = await cpp.getCppToolsApi(cpp.Version.v6);
        }

        if (this.cppToolsAPI) {
            this.cppToolsAPI.registerCustomConfigurationProvider(this.cppConfigurationProvider);
        }
    }

    public buildCustomConfigurationProvider(customConfigProviderItem: toolParser.CustomConfigProviderItem): void {
        this.compilerFullPath = customConfigProviderItem.compilerFullPath;
        let provider: cpptools.CustomConfigurationProvider = this.getCppConfigurationProvider().getCustomConfigurationProvider();

        const configuration: cpp.SourceFileConfiguration = {
            defines: customConfigProviderItem.defines,
            standard: customConfigProviderItem.standard,
            includePath: customConfigProviderItem.includes,
            forcedInclude: customConfigProviderItem.forcedIncludes,
            intelliSenseMode: customConfigProviderItem.intelliSenseMode,
            compilerPath: customConfigProviderItem.compilerFullPath,
            compilerArgs: customConfigProviderItem.compilerArgs,
            windowsSdkVersion: customConfigProviderItem.windowsSDKVersion
        };

        // cummulativeBrowsePath incorporates all the files and the includes paths
        // of all the compiler invocations of the current configuration
        customConfigProviderItem.files.forEach(filePath => {
            let uri: vscode.Uri = vscode.Uri.file(filePath);
            let sourceFileConfigurationItem: cpptools.SourceFileConfigurationItem = {
                uri,
                configuration,
                compileCommand: {
                   command: customConfigProviderItem.line,
                   directory: customConfigProviderItem.currentPath,
                   file: filePath
                }
            };

            // These are the configurations processed during the current configure.
            // Store them in the 'delta' file index instead of the final one.
            provider.fileIndex.set(path.normalize((process.platform === "win32") ? uri.fsPath.toUpperCase() : uri.fsPath),
                                                  sourceFileConfigurationItem);
            extension.getCppConfigurationProvider().logConfigurationProviderItem(sourceFileConfigurationItem);

            let folder: string = path.dirname(filePath); // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(folder)) {
                provider.workspaceBrowse.browsePath.push(folder);
            }
        });

        customConfigProviderItem.includes.forEach(incl => { // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(incl)) {
                provider.workspaceBrowse.browsePath.push(incl);
            }
        });

        customConfigProviderItem.forcedIncludes.forEach(fincl => {
            let folder: string = path.dirname(fincl); // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(folder)) {
                provider.workspaceBrowse.browsePath.push(fincl);
            }
        });
    }

    public getCompilerFullPath() : string | undefined { return this.compilerFullPath; }
}

export async function openSettings(setting: string) : Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openSettings", setting);
    await vscode.commands.executeCommand("workbench.action.openWorkspaceSettings");
}

async function openEditor(file: string) {
    await vscode.workspace.findFiles(file, undefined, 1).then(
        files => {
            if (files.length > 0) {
                vscode.workspace.openTextDocument(files[0]).then(
                    doc => vscode.window.showTextDocument(doc, { preview: true})
                    );
            }
        }
    )
}

function openLog(selected: tree.Node): Thenable<vscode.TextDocument> {
    let top_builddir =
        configuration.getCurrentMakefileConfiguration().top_builddir;
    let logfile = selected.logfile();
    if (logfile && top_builddir) {
        let uri = vscode.Uri.file(path.join(top_builddir, logfile));
        return vscode.workspace.openTextDocument(uri).then((e) =>
            vscode.window.showTextDocument(e,
                    {preview: true, viewColumn: vscode.ViewColumn.One, preserveFocus: true})
            .then((e) =>
                {
                    return vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
                }
            )
        );
    }
    return Promise.reject();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    statusBar = ui.getUI();
    extension = new Extension(context);
    await extension.setFullFeatureSet(false);

    telemetry.activate();

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildConfiguration', async () => {
        await configuration.setNewConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getConfiguration', async () => {
        telemetry.logEvent("getConfiguration");
        return configuration.getCurrentMakefileConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.goal', async () => {
        telemetry.logEvent("goal");
        return (await configuration.getCurrentTarget()).goal;
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.builddir', async () => {
        telemetry.logEvent("builddir");
        return (await configuration.getCurrentTarget()).builddir;
    }));

    // Return the relative path to the default build task's target
    // or the first Linked_binary target detected.
    // Due to bug in cpptools, this temporarily returns an absolute path (always), but
    // this will eventually be fixed. Don't rely on abs paths.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.default_program', async () => {
        telemetry.logEvent("default_program");
        let built = await configuration.getCurrentTarget();
        // cpptools has a bug where if the "program" member of a launch debug configuration
        // is a relative path, it checks in the wrong directory and fails to find it.
        // Work around this by using the absolute path of the builddir until bug is fixed
        // I want to use relative path to avoid accessing parent dirs (which may be EACCESS)
        // but currently a lot of vscode would break if parent dirs to to user's home
        // were EACCESS.
        let cpptools_stat_bug = true;
        let goal_path = path.join(built.builddir ?? '.', built.goal);
        let c = configuration.getCurrentMakefileConfiguration();
        // goal_path can be absolute if the builddir in task.json is absolute
        // automatic tasks have a relative builddir
        if (cpptools_stat_bug) {
            let builddir = c.top_builddir;
            let abs_builddir =
                path.isAbsolute(builddir) ? builddir :
                resolvePathToRoot(c.top_builddir);
            return path.isAbsolute(goal_path) ?
                goal_path :
                path.join(abs_builddir, goal_path).normalize();
        }
        return path.isAbsolute(goal_path) ?
            goal_path :
            path.join(c.top_builddir, goal_path).normalize();
    }));

    // Return the name of the build task that would build the default_program. It is meant to be
    // used in the preLaunchTask property of a debug configuration, so the debugged program is built
    // before launching
    context.subscriptions.push(vscode.commands.registerCommand('autotools.default_program_build_task', async () => {
        telemetry.logEvent("default_program");
        let built = await configuration.getCurrentTarget();
        return 'autotools: build \'' + built.goal + '\' in ' + built.builddir;
    }));
    /** End of commands that shouldn't be exposed in package.json, they are used for command substitution in launch.json and tasks.json. */

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildAll', async () => {
        const kind:BuildTask = {
            type: "build",
            target: make.t_all
        };
        let top_builddir = configuration.getCurrentMakefileConfiguration().top_builddir;
        await vscode.tasks.executeTask(new vscode.Task(kind, vscode.TaskScope.Workspace, 'build all', 'autotools',
            new vscode.ProcessExecution(configuration.getMakePath(),
                (top_builddir ? ['-C', top_builddir] : [])
                .concat(make.t_all.goal)
            )));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.exportToIntelisense', async () => {
        await make.configure(make.TriggeredBy.configure);
    }));

    // Reset state - useful for troubleshooting.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.resetState', () => {
        telemetry.logEvent("commandResetState");
        extension.getState().reset();
    }));

    //context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.configure', () => {
    //    return vscode.commands.executeCommand("autotools.configure");
    //}));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        telemetry.logEvent("configure");
        extension.configure();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.build', async (sub: tree.TaskNode) => {
        telemetry.logEvent("build");
        if (!sub.goal?.task)
            throw new Error("Missing build task on TaskNode");
        return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildTarget', () => {
        return vscode.commands.executeCommand("autotools.buildTarget");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.build', async (sub: tree.TaskNode) => {
        telemetry.logEvent("build");
        if (!sub.goal.task)
            throw new Error("Missing build task on TaskNode");
        return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.check', async (sub: tree.SubNode) => {
        telemetry.logEvent("check");
        /* Must be a SubNode */
        if (!sub.submake.test_suite)
            throw new Error("Missing test suite on SubNode");
        if (!sub.submake.test_suite.task)
            throw new Error("Missing check task on SubNode");
        return await vscode.tasks.executeTask(sub.submake.test_suite.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editMakefileAm', async (sub: tree.SubNode) => {
        telemetry.logEvent("editMakefileAm");
        await openEditor(sub.makefile());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.newConfiguration', async (sub: tree.Node | undefined) => {
        telemetry.logEvent("newConfiguration");
        openSettings("autotools.configurations");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editConfigureAc', async (sub: tree.SubNode) => {
        telemetry.logEvent("editConfigureAc");
        let configureAc = configuration.getConfigureAc();
        if (configureAc)
            await openEditor(configureAc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.test', async (sub: tree.TaskNode) => {
        telemetry.logEvent("test");
        if (!sub.goal.task)
            throw new Error("Missing test task on TaskNode");
        return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.debug', async (sub: tree.TaskNode) => {
        telemetry.logEvent("debug");
        if (!sub.goal.task)
            throw new Error("Missing test task on TaskNode");
        return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.openLog', async (sub: tree.SubNode) => {
        telemetry.logEvent("openLog");
        return Promise.resolve(openLog(sub));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setBuildConfiguration', () => {
        return vscode.commands.executeCommand("autotools.setBuildConfiguration");
    }));

    vscode.commands.executeCommand("setContext", "autotools.isBootstrapped", extension.isBootstrapped());

    // Read from the workspace state before reading from settings,
    // becase the latter may use state info in variable expansion.
    configuration.initFromState();
    await configuration.initFromSettings(true);

    const openFile = async (fileUri: vscode.Uri) => {
        await vscode.commands.executeCommand("vscode.open", fileUri);
        await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
    }

    extension.registerTasks();

    let configureAc = configuration.getConfigureAc();
    if (configureAc) {
        context.subscriptions.push(vscode.workspace.createFileSystemWatcher('**/Makefile.am')
            .onDidChange((e) => {  extension.regen(); }));
        if (!configureAc.endsWith(".in")) {
            context.subscriptions.push(vscode.workspace.createFileSystemWatcher(configureAc)
                .onDidChange((e) => { extension.recheck(); }));
        }
        context.subscriptions.push(vscode.workspace.createFileSystemWatcher('**/*.in')
            .onDidChange((e) => {  extension.regen(); }));
    }

    extension.createPanel(context);

    vscode.window.registerFileDecorationProvider(extension.suiteDecorator);

    // Analyze settings for type validation and telemetry
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
    let telemetryProperties: telemetry.Properties | null = {};
    try {
        telemetryProperties = await telemetry.analyzeSettings(workspaceConfiguration, "autotools",
            util.thisExtensionPackage().contributes.configuration.properties,
            true, telemetryProperties);
    } catch (e) {
        telemetry.telemetryLogger(e.message);
    }

    if (telemetryProperties && util.hasProperties(telemetryProperties)) {
        telemetry.logEvent("settings", telemetryProperties);
    }

    if (!configuration.getConfigurationMakefile()) {
        ui.getUI().setLoading(ui.UIStatus.ERR);
        return;
    }
    await make.configure(make.TriggeredBy.cleanConfigure);
}

export async function deactivate(): Promise<void> {
    vscode.window.showInformationMessage(localize("extension.deactivated", "The extension {0} is de-activated.", "'vscode-makefile-tools'"));

    await telemetry.deactivate();

    const items : any = [
        extension,
        statusBar
    ];

    for (const item of items) {
        if (item) {
            item.dispose();
        }
    }
}
