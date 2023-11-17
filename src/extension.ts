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
import * as path from 'path';
import * as state from './state';
import * as telemetry from './telemetry';
import * as tree from './tree';
import * as ui from './ui';
import * as util from './util';
import { resolvePathToRoot, checkFileExistsSync } from './util';
import * as vscode from 'vscode';
import * as cpp from 'vscode-cpptools';
import { AutoToolsBuildTaskProvider,
        AutoToolsTestTaskProvider,
        AutoToolsCheckTaskProvider,
        AutoToolsBootstrapTaskProvider,
        BuildTask,
        MyTaskProvider } from './tasks';
import { SuiteDecorations } from './suite-decorator';

import * as nls from 'vscode-nls';
import { allowedNodeEnvironmentFlags } from 'process';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

let statusBar: ui.UI = ui.getUI();

export let extension: Extension;

export class Extension {
    static readonly whoami: string = "mergesium.autotools";

    private mementoState = new state.StateManager(this.extensionContext);
    public readonly _projectOutlineProvider = new tree.ProjectOutlineProvider(this.mementoState.buildConfiguration || 'Default');
    private readonly _projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
        treeDataProvider: this._projectOutlineProvider,
        showCollapseAll: false
    });
    public readonly suiteDecorator = new SuiteDecorations();

    private readonly cppConfigurationProvider = new cpptools.CppConfigurationProvider();
    public getCppConfigurationProvider(): cpptools.CppConfigurationProvider { return this.cppConfigurationProvider; }

    private cppToolsAPI?: cpp.CppToolsApi;
    private cppConfigurationProviderRegister?: Promise<void>;
    private tasks: MyTaskProvider[];
    private bootstrapTask: AutoToolsBootstrapTaskProvider;
    private buildTasks: AutoToolsBuildTaskProvider;
    private compilerFullPath ?: string;

    public constructor(public readonly extensionContext: vscode.ExtensionContext) {
        this.bootstrapTask = new AutoToolsBootstrapTaskProvider();
        this.buildTasks = new AutoToolsBuildTaskProvider();
        this.tasks = [
            this.bootstrapTask,
            this.buildTasks,
            new AutoToolsTestTaskProvider(),
            new AutoToolsCheckTaskProvider(),
        ];
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.bootstrap', async () => {
            await this.bootstrapTask.bootstrap();
        }));
        this._projectOutlineTreeView.onDidChangeSelection((e) => {
            if (e.selection.length > 0) {
                let selected = e.selection[0];
                if (selected instanceof tree.Node && !(selected instanceof tree.SubNode)) {
                    return openLog(selected);
                }
            }
        })
    }

    public registerTasks(): void {
        // FIXME: Implement Disposable
        this.tasks.forEach((provider) => vscode.tasks.registerTaskProvider(provider.myType, provider));

        if (!this.bootstrapTask.isBootstrapped()) {
            let cmd = this.bootstrapTask.bootstrap_cmd();
            if (cmd) {
                const doit: string = localize("autotools.bootstrap.me", "Bootstrap");
                vscode.window.showErrorMessage(
                    localize("autotools.want.bootstrap", "The project needs to be bootstrapped ('{0}').", cmd.join(' ')),
                    doit,
                    localize("autotools.cancel", "Cancel")).then((value) => {
                    if (value === doit) {
                        this.bootstrapTask.bootstrap();
                    }
                });
            }
        }

        // FIXME: This is a workaround for vscode not parsing tasks.json prior to fetchTasks()
        const kind:BuildTask = {
            type: "build",
            target: new make.BuildTarget(".", "fetchTasks-bug-workaround")
        };
        vscode.tasks.executeTask(new vscode.Task(kind, vscode.TaskScope.Workspace, 'autotools', 'autotools',
            new vscode.ProcessExecution("true", ["this-is-a-workaround-for-fetchTasks-bug-not-parsing-tasks-json"])));
    }
    public updateTasks(build_tree: gnumake.Make): void {
        this.tasks.forEach((provider) => provider.update());
        this._projectOutlineProvider.updateTargets(build_tree);
        this._projectOutlineTreeView.reveal(this._projectOutlineProvider.getChildren(undefined)[0],
            { select: false, focus: false, expand: true, } );
    }
    public bootstrap(): void { this.bootstrapTask.bootstrap(); }
    public build(target: make.BuildTarget): void { this.buildTasks.build(target); }

    public updateMakefileFilePresent(newValue: boolean): void {
        vscode.commands.executeCommand("setContext", "autotools.makefileFilePresent", newValue);
    }

    public getState(): state.StateManager { return this.mementoState; }

    public dispose(): void {
        this._projectOutlineTreeView.dispose();
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
                    {preview: true, viewColumn: vscode.ViewColumn.One})
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
        // goal_path can be absolute if the builddir in task.json is absolute
        // automatic tasks have a relative builddir
        if (cpptools_stat_bug) {
            let builddir = configuration.getCurrentMakefileConfiguration().top_builddir || '.';
            let abs_builddir =
                path.isAbsolute(builddir) ? builddir :
                util.resolvePathToRoot(configuration.getCurrentMakefileConfiguration().top_builddir || "");
            return path.isAbsolute(goal_path) ?
                goal_path :
                path.join(abs_builddir, goal_path).normalize();
        }
        return path.isAbsolute(goal_path) ?
            goal_path :
            path.join(configuration.getCurrentMakefileConfiguration().top_builddir || '.', goal_path).normalize();
    }));

    // Return the name of the build task that would build the default_program. It is meant to be
    // used in the preLaunchTask property of a debug configuration, so the debugged program is built
    // before launching
    context.subscriptions.push(vscode.commands.registerCommand('autotools.default_program_build_task', async () => {
        telemetry.logEvent("default_program");
        let built = await configuration.getCurrentTarget();
        return 'autotools: build \'' + built.goal + '\' in ' + built.builddir;
    }));

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
    /** End of commands that shouldn't be exposed in package.json, they are used for command substitution in launch.json and tasks.json. */

    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        await make.configure(make.TriggeredBy.configure);
    }));

    // Reset state - useful for troubleshooting.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.resetState', () => {
        telemetry.logEvent("commandResetState");
        extension.getState().reset();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.configure', () => {
        return vscode.commands.executeCommand("autotools.configure");
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

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editConfigureAc', async (sub: tree.SubNode) => {
        telemetry.logEvent("editConfigureAc");
        await openEditor("configure.ac");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.test', async (sub: tree.TaskNode) => {
        telemetry.logEvent("test");
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

    // Read from the workspace state before reading from settings,
    // becase the latter may use state info in variable expansion.
    configuration.initFromState();
    await configuration.initFromSettings(true);

    const openFile = async (fileUri: vscode.Uri) => {
        await vscode.commands.executeCommand("vscode.open", fileUri);
        await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
    }

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.openMakefilePathSetting', async () => {
        await openSettings("autotools.makefilePath");
    }));

    extension.registerTasks();

    vscode.window.registerFileDecorationProvider(extension.suiteDecorator);

    await make.configure(make.TriggeredBy.cleanConfigure);

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
