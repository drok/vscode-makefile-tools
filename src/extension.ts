// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Makefile Tools extension

import * as configuration from './configuration';
import * as cpptools from './cpptools';
import * as fs from 'fs';
import * as logger from './logger';
import * as make from './make';
import * as toolParser from './parser/tool';
import * as path from 'path';
import * as state from './state';
import * as telemetry from './telemetry';
import * as tree from './tree';
import * as ui from './ui';
import * as util from './util';
import * as vscode from 'vscode';
import * as cpp from 'vscode-cpptools';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

let statusBar: ui.UI = ui.getUI();

export let extension: MakefileToolsExtension;

export class MakefileToolsExtension {
    public readonly _projectOutlineProvider = new tree.ProjectOutlineProvider();
    private readonly _projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
        treeDataProvider: this._projectOutlineProvider,
        showCollapseAll: false
    });

    private readonly cppConfigurationProvider = new cpptools.CppConfigurationProvider();
    public getCppConfigurationProvider(): cpptools.CppConfigurationProvider { return this.cppConfigurationProvider; }

    private mementoState = new state.StateManager(this.extensionContext);
    private cppToolsAPI?: cpp.CppToolsApi;
    private cppConfigurationProviderRegister?: Promise<void>;
    private compilerFullPath ?: string;

    public constructor(public readonly extensionContext: vscode.ExtensionContext) {
    }

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    statusBar = ui.getUI();
    extension = new MakefileToolsExtension(context);
    configuration.disableAllOptionallyVisibleCommands();
    await extension.setFullFeatureSet(false);

    telemetry.activate();

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildConfiguration', async () => {
        await configuration.setNewConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getConfiguration', async () => {
        telemetry.logEvent("getConfiguration");
        return configuration.getCurrentMakefileConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildTarget', async () => {
       await configuration.selectTarget(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getBuildTargetName', async () => {
        telemetry.logEvent("getBuildTargetName");
        return configuration.getCurrentTarget().name;
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getBuildTargetDir', async () => {
        telemetry.logEvent("getBuildTargetDir");
        return configuration.getCurrentTarget().dir;
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildTarget', async () => {
        await make.buildTarget(make.TriggeredBy.buildTarget, configuration.getCurrentTarget(), false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildCleanTarget', async () => {
        await make.buildTarget(make.TriggeredBy.buildCleanTarget, configuration.getCurrentTarget(), true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildAll', async () => {
        await make.buildTarget(make.TriggeredBy.buildAll, make.t_all, false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildCleanAll', async () => {
        await make.buildTarget(make.TriggeredBy.buildCleanAll, make.t_all, true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.makeBaseDirectory', () => {
        telemetry.logEvent("makeBaseDirectory");
        return configuration.makeBaseDirectory();
    }));
    /** End of commands that shouldn't be exposed in package.json, they are used for command substitution in launch.json and tasks.json. */

    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        await make.configure(make.TriggeredBy.configure);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.cleanConfigure', async () => {
        await make.cleanConfigure(make.TriggeredBy.cleanConfigure);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.preConfigure', async () => {
        await make.preConfigure(make.TriggeredBy.preconfigure);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.postConfigure', async () => {
        await make.postConfigure(make.TriggeredBy.postConfigure);
    }))

    // Reset state - useful for troubleshooting.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.resetState', () => {
        telemetry.logEvent("commandResetState");
        extension.getState().reset();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.configure', () => {
        return vscode.commands.executeCommand("autotools.configure");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.cleanConfigure', () => {
        return vscode.commands.executeCommand("autotools.cleanConfigure");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.preConfigure', () => {
        return vscode.commands.executeCommand("autotools.preConfigure");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.postConfigure', () => {
        return vscode.commands.executeCommand("autotools.postConfigure");
    }))

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setBuildTarget', () => {
        return vscode.commands.executeCommand("autotools.setBuildTarget");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildTarget', () => {
        return vscode.commands.executeCommand("autotools.buildTarget");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildCleanTarget', () => {
        return vscode.commands.executeCommand("autotools.buildCleanTarget");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setBuildConfiguration', () => {
        return vscode.commands.executeCommand("autotools.setBuildConfiguration");
    }));

    // Read from the workspace state before reading from settings,
    // becase the latter may use state info in variable expansion.
    configuration.initFromState();
    await configuration.initFromSettings(true);

    const openSettings = async (setting: string) => {
        await vscode.commands.executeCommand("workbench.action.openSettings", setting);
        await vscode.commands.executeCommand("workbench.action.openWorkspaceSettings");
    }

    const openFile = async (fileUri: vscode.Uri) => {
        await vscode.commands.executeCommand("vscode.open", fileUri);
        await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
    }

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.openMakefilePathSetting', async () => {
        await openSettings("autotools.makefilePath");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.openMakefileFile', async () => {
        const makefile = configuration.getConfigurationMakefile();
        if (makefile) {
            if (util.checkFileExistsSync(makefile)) {
                await openFile(vscode.Uri.file(makefile));
            }
            else {
                extension.updateMakefileFilePresent(false);
                vscode.window.showErrorMessage(localize("autotools.outline.makefileFileNotFound", "The makefile file could not be opened."));
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.openMakePathSetting', async () => {
        await openSettings("autotools.makePath");
    }));

    // Delete the script that is created by this extension in the temporary folder
    // with the purpose of spliting a compilation command fragment into switch arguments
    // as the shell sees them. See more about this script in parser.ts, parseAnySwitchFromToolArguments.
    // We need to delete this file occasionally to ensure that the extension will not use indefinitely
    // an eventual old version, especially because for performance reasons we don't create this file
    // every time we use it (the configure process creates it every time it's not found on disk).
    // Deleting this script here ensures that every new VSCode instance will operate on up to date script functionality.
    let parseCompilerArgsScript: string = util.parseCompilerArgsScriptFile();
    if (util.checkFileExistsSync(parseCompilerArgsScript)) {
        util.deleteFileSync(parseCompilerArgsScript);
    }

    if (configuration.getConfigureOnOpen() && extension.getFullFeatureSet()) {
        // Always clean configure on open
        await make.cleanConfigure(make.TriggeredBy.cleanConfigureOnOpen);
    }

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
