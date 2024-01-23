// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Makefile Tools extension

import * as configuration from './configuration';
import { MakefileConfiguration, TestEnvironment } from './configuration';
import * as cpptools from './cpptools';
import * as fs from 'fs';
import * as logger from './logger';
import * as util from './util';
import * as make from './make';
import * as toolParser from './parser/tool';
import * as gnumake from './parser/gnumake';
import { Goal } from './parser/gnumake';
import * as path from 'path';
import * as state from './state';
// import * as telemetry from './telemetry';
import { SpanStatusCode } from './tele';
import {
    ProjectOutlineProvider,
    ProjectTestsProvider,
    } from './tree';
import * as tree from './tree';
import * as ui from './ui';
import { resolvePathToRoot,
         checkFileExistsSync } from './util';
import * as vscode from 'vscode';
import * as cpp from 'vscode-cpptools';
import * as debugProvider from './debug';
import { DebugNow } from './debug';
import { MyTestController } from './test';
import { AutoToolsBuildTaskProvider,
        AutoToolsTestTaskProvider,
        AutoToolsCheckTaskProvider,
        AutoToolsBootstrapTaskProvider,
        AutotoolsTask,
        BuildTask,
        TestTask,
        MyTaskProvider } from './tasks';
import { SuiteDecorations } from './suite-decorator';
import * as tele from './tele';
import * as nls from 'vscode-nls';
import { assert } from 'console';
import { installAutotools } from './install';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export const statusBar: ui.UI = ui.getUI();

export let extension: Extension;
export let telemetry: tele.MyTelemetry;
export class Extension {
    static readonly whoami: string = "mergesium.autotools";

    private mementoState = new state.StateManager(this.extensionContext);
    public readonly _projectOutlineProvider = new ProjectOutlineProvider(this.mementoState.buildConfiguration);
    public readonly _projectTestSuitesProvider = new ProjectTestsProvider();
    private _projectOutlineTreeView : vscode.TreeView<tree.Node> | undefined;
    private _projectTestSuitesView : vscode.TreeView<tree.Node> | undefined;
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
    public readonly testRunner : string;
    public testController : MyTestController | undefined;
    public pkginfo : make.pkgInfo | undefined;
    private _treeDisposables: vscode.Disposable[] = [];

    public constructor(public readonly extensionContext: vscode.ExtensionContext, teleParams: tele.Params) {
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
        this.testRunner = path.join(extensionContext.extensionPath, "bin/test-driver");

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.bootstrap', async () => {
            await this.autotoolsTask.bootstrap();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.regen', async () => {
            await this.autotoolsTask.regen();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.configure.help', async () => {
            await this.autotoolsTask.help();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.knowledgeBase', async () => {
            await this.gotoKnowledgeBase();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.openKnowledgeBase', async () => {
            await this.gotoKnowledgeBase();
        }));
        debugProvider.activate(extensionContext);

        telemetry = new tele.MyTelemetry(extensionContext, teleParams);
    }
    public async kbUrl() : Promise<vscode.Uri> {
        if (!this.pkginfo)
            this.pkginfo = await make.getPackageJSON().catch(() => undefined);

        if (!this.pkginfo)
            return Promise.reject();

        var url = vscode.Uri.from({
            scheme: 'https',
            authority: 'autotools.mergesium.com',
            path: '/kb/' + util.slugify(this.pkginfo?.name ?? 'unknown'),
            // The s- prefix matches my_kramdown_patch
            // Used for headings that start with digits (1.0.0) because html element ids cannot begin with non letter
            query: this.pkginfo?.version.match(/^a-zA-Z/) ?
                'v=' + util.slugify('s-' + this.pkginfo?.version) :
                this.pkginfo?.version ? 'v=' + util.slugify(this.pkginfo?.version) : undefined
        });
        return Promise.resolve(url);
    }
    async gotoKnowledgeBase() {
        let kburl = await this.kbUrl();
        vscode.commands.executeCommand('vscode.open', kburl.toString(true));
    }
    public createPanel() : void {
        this._projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
            treeDataProvider: this._projectOutlineProvider,
            showCollapseAll: false

        });
        this._projectTestSuitesView = vscode.window.createTreeView('autotools.tests', {
            treeDataProvider: this._projectTestSuitesProvider,
            showCollapseAll: false

        });
        this._treeDisposables.push(this._projectTestSuitesView.onDidChangeSelection((e) => {
            if (e.selection.length > 0) {
                let selected = e.selection[0];
                if (selected instanceof tree.Node && !(selected instanceof tree.SubNode)) {
                    return openLog(selected);
                }
            }
        }));
        // this._projectOutlineTreeView.description = "outline description";
        // this._projectTestSuitesView.description = configuration.getCurrentTestEnvironment().name;
        // this._projectOutlineTreeView.message = "outline message";
    }
    public setConfiguration(name: string) {
        if (this._projectOutlineTreeView) {
            var projname = this.pkginfo ? (this.pkginfo.name + ' ' + this.pkginfo.version) : "";
            this._projectOutlineTreeView.description = `${projname} - ${name}`;
        }
    }
    public setTestEnvironment() {
        if (this._projectTestSuitesView) {
            var name = configuration.getCurrentTestEnvironment().name;
            this._projectTestSuitesView.description = `env: "${name}"`;
        }
    }
    public deletePanel() : void {
        if (this._projectOutlineTreeView) {
            this._projectOutlineTreeView = undefined;
            this._treeDisposables.forEach((d) => d.dispose());
            this._treeDisposables = [];

            this.testController?.deactivate();
            this.testController = undefined;
        }
    }

    failStatUpdate(oldresult: make.TRS, result: make.TRS) {
        assert(oldresult != result, "in failStatUpdate result should be different", [oldresult, result]);
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

    /**
     * Handler for TRS file changes. Updates the Goal's trs structure with the current and global results
     * @param c {@linkcode MakefileConfiguration Current build configuration}
     * @param env {@linkcode TestEnvironment} The TestEnvironment that is the "current", used to select the right :test-result: TRS line
     * @param uri the uri of the TRS file as reported by fs.watch
     */
    trsChange(c: MakefileConfiguration, env: TestEnvironment, uri: vscode.Uri) : void {

        let dir = path.relative(util.resolvePathToRoot(c.top_builddir), path.dirname(uri.path));
        let log = path.basename(uri.path, ".trs") + ".log";
        let goal = configuration.getAllBuildTargets()
            ?.get(dir)
            ?.get('test-suite.log')
            ?.depends?.find((d) => d.goal === log);

        if (goal) {
            let old = goal.trs;
            goal.trs = make.readTRS(new make.BuildTarget(dir, log), env, c);
            if (goal.trs.current != old?.current) {
                this.suiteDecorator.update(vscode.Uri.from(
                    {authority: Extension.whoami, scheme: 'test', path: '/' + dir, query: log}));
                this.suiteDecorator.update(vscode.Uri.from(
                    {authority: Extension.whoami, scheme: 'check', path: '/' + dir, query: 'test-suite.log'}));
                this.failStatUpdate(old?.current || make.TRS.NONE, goal.trs.current);
                // Don't update the test suites. They are auto summarized
                this.updateOutlineBadge();
            }
            if ( goal.test && goal.trs.global != old?.global && !(goal.flags & Goal.Flags.Test_Suite))
                this.testController?.trsChange(goal.test);

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
                if (definition.type == "test" && definition.test) {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.test.builddir)
                        ?.get('test-suite.log');
                    if (suite) {
                        let goal = suite.depends?.find((d) => d.goal === definition.test?.goal);
                        if (goal) {
//                            let result : make.TRS;
//                            if (e.exitCode) {
//                                // Test did not run
//                                result = make.TRS.ERROR;
//                            } else {
//                                result = make.readTRS(definition.test);
//                            }
//                            goal.flags &= ~Goal.Flags.Test_Result_Mask;
//                            goal.flags |= result;
//                            let oldresult = goal.flags & Goal.Flags.Test_Result_Mask;
//                            if (result != oldresult) {
//                                goal.flags &= ~Goal.Flags.Test_Result_Mask;
//                                goal.flags |= result;
//                                this.suiteDecorator.update(vscode.Uri.from(
//                                    {authority: Extension.whoami, scheme: 'test', path: '/' + definition.test.builddir, query: definition.test.goal}));
//                                this.suiteDecorator.update(vscode.Uri.from(
//                                    {authority: Extension.whoami, scheme: 'check', path: '/' + definition.test.builddir, query: 'test-suite.log'}));
//                                this.failStatUpdate(oldresult, result);
//                                this.updateOutlineBadge();
//                            }
                            // Should wait for tasks.trsChange()
                            definition.test && goal.test && this.testController?.testCompleted(goal.test, definition.test);
                        }
                    }
/*
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
                                //if (test.task instanceof vscode.Task)
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
*/
                } else if (definition.type == 'check') {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.builddir)
                        ?.get('test-suite.log');
                    if (suite && suite.test) {
                        this.testController?.suiteCompleted(suite.test);
                    }
                } else if (definition.type == "autotools") {
                    const definition: AutotoolsTask = <any>task.definition;
                    if (definition?.action == "regen" || definition?.action == "recheck")
                        ui.getUI().setStatus(e.exitCode ? ui.UIStatus.ERR : ui.UIStatus.OK);
                        this.autotoolsTask.autotoolsDone(task.execution,
                            (typeof e.exitCode == 'number') ? e.exitCode : (e.exitCode ? 1 : 0));
                        if (!e.exitCode) {
                            make.configure(make.TriggeredBy.configureAfterConfigurationChange);
                        }
//                } else if (definition.type == "test-NOPE" && definition.test) {
//                    let suite = configuration.getAllBuildTargets()
//                        ?.get(definition.test.builddir)
//                        ?.get('test-suite.log');
//                    this.testController.testCompleted(definition.goal.test);
                }
            }
        });

        vscode.commands.executeCommand("setContext", "autotools:isAutotoolsProject",
            this.isAutotoolsProject() ? 1 : 2);

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
        if (this.needTaskFetchBugWorkaround && this.isAutotoolsProject()) {
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
        if (!this._projectTestSuitesView) {
            return;
        }
        if (this.testTasks.numFails) {
            this._projectTestSuitesView.badge =
                {tooltip:
                    localize("autotools.failing.tests", "{0}/{1} tests FAIL",
                        this.testTasks.numFails, this.testTasks.numTests),
                value: this.testTasks.numFails};
        } else if (this.testTasks.numSuspect) {
            this._projectTestSuitesView.badge =
                {tooltip:
                    localize("autotools.suspect.tests", "{0}/{1} tests are suspect (XPASS/XFAIL/ERROR)",
                        this.testTasks.numSuspect, this.testTasks.numTests),
                value: this.testTasks.numSuspect};
        } else if (this.testTasks.numTests && this.testTasks.numUnknown) {
            this._projectTestSuitesView.badge =
                {tooltip:
                    localize("autotools.unknown.tests", "{0}/{1} tests are available/not yet run",
                        this.testTasks.numUnknown, this.testTasks.numTests),
                value: this.testTasks.numUnknown};
        } else {
            this._projectTestSuitesView.badge =
                {tooltip:
                    localize("autotools.no.tests", "No tests available"),
                value: 0
            };
        }
    }

    public updateWatchers() {
        this.configDisposables.concat([...Array.from(configuration.getAllBuildTargets().keys())
            .map( (p) => new util.MyFileWatcher(resolvePathToRoot(p), (e, f) => {
                if (f == 'Makefile.am' || (f.endsWith('.in') && f != 'Makefile.in'))
                    /* Regen if config*.in files change, other than Makefile.in which is updated due to Makefile.am */
                    extension.regen();
            }))]);
    }
    private configDisposables : vscode.Disposable[] = [];
    private buildTree: gnumake.Make | undefined;
    public resyncTasks(): void {
        if (this.buildTree)
            this.updateTasks(this.buildTree);
    }
    public updateTasks(build_tree: gnumake.Make): void {
        this.buildTree = build_tree;
        this.configDisposables.forEach((d) => d.dispose());
        this.configDisposables = [];
        if (!build_tree.hasStats) {
            countStats(build_tree);
            build_tree.hasStats = true;
        }
        if (build_tree.stats.checks) {
            if (!this.testController) {
                this.testController = new MyTestController(
                    Extension.whoami, "Autotools tests", extension.getState().liveCheckId);
            }
            this.testController.clear();
        } else {
            this.testController?.deactivate();
            this.testController = undefined;
        }
        this.tasks.forEach((provider) => provider.update(this.configDisposables));
        if (this._projectOutlineTreeView) {
            this._projectOutlineProvider.updateTargets(build_tree);
            this._projectOutlineTreeView.reveal(this._projectOutlineProvider.getChildren(undefined)[0],
                { select: false, focus: false, expand: true, } );
        }
        if (this._projectTestSuitesView) {
            this._projectTestSuitesProvider.updateTargets(build_tree);
            this._projectTestSuitesView.reveal(this._projectTestSuitesProvider.getChildren(undefined)[0],
                { select: false, focus: false, expand: true, } );
            this.updateOutlineBadge();
        }
        this.updateTestSuite(build_tree, build_tree, true);
        this.testController?.onOpenedDocument();
        this.testController?.restoreLiveCheck();
    }
    updateTestSuite(sub: gnumake.Make, parent: gnumake.Make, top: boolean): void {
        let c = configuration.getCurrentMakefileConfiguration();
        for (let submake of sub.submake.values()) {
            if (submake.test_suite?.test && parent.test_suite?.test)
                extension.testController?.addSubTest(parent.test_suite.test, submake.test_suite.test);
            //if (submake.test_suite?.test)
            this.updateTestSuite(submake, sub.test_suite ? sub : parent, top && !sub.test_suite);
        }
        if (sub.test_suite && sub.test_suite.test) {
            //let logpath = path.join(c.top_builddir, sub.dir);
            sub.test_suite.depends?.forEach((test) => {
                sub.test_suite?.test && extension.testController?.addTest(c, sub.dir, sub.test_suite.test, test)});
        }
        if (top && sub.test_suite?.test)
            this.testController?.update(sub.test_suite.test);
    }

    // goal is the *.log goal. The executable will be read from .depends[0]
    async debugGoal(goal: Goal, builddir: string, env: configuration.TestEnvironment) : Promise<void> {
        if (goal?.depends?.length && goal.depends[0].goal) {
            let c = configuration.getCurrentMakefileConfiguration();
            let dopt : vscode.DebugSessionOptions = {
                compact: true
            };
            vscode.debug.startDebugging(
                vscode.workspace.workspaceFolders?.[0],
                new DebugNow(c, {goal: goal.depends[0].goal, builddir: builddir},
                        !!(goal.depends[0].flags & Goal.Flags.Linked_binary)),
                dopt)
            .then((z) => console.log(z));
        }
    }

    public onConfigurationSelect(c: configuration.MakefileConfiguration) : void {
        this.tasks.forEach((provider) => provider.changeConfiguration(c, this.configDisposables));
        this.setConfiguration(c.name);
    }
    public bootstrap(): void { this.autotoolsTask.bootstrap(); }
    // config.status (just re-output)
    public async regen(): Promise<void> { await this.autotoolsTask.regen(); }
    // config.status --recheck
    public async recheck(changed: boolean): Promise<void> {
        if (changed) {
            if (!this.isAutotoolsProject() && this.autotoolsTask.bootstrap_cmd()) {
                // newly installed
                statusBar.show();
                configuration.initFromState();
                await configuration.initFromSettings(true);
                await outputLogHeader();
                await extension.configure();
                return Promise.resolve();
            } else if (this.isAutotoolsProject() && !this.autotoolsTask.bootstrap_cmd()) {
                // Disable extension, configure.ac deleted
                return Promise.resolve();
            }
        }
        await this.autotoolsTask.recheck();
        return Promise.resolve();
    }
    public autotoolsDoneNoResult(): void { this.autotoolsTask.autotoolsDoneNoResult(); }

    public build(target: make.BuildTarget): void { this.buildTasks.build(target); }
    public async configure(): Promise<boolean> {
        this.needTaskFetchBugWorkaround = false;
        var success =  await this.autotoolsTask.configure();
        if (!success) {
            let kbUrl = await extension.kbUrl();
            logger.message('Configure failed. Review the Terminal tab for cause.', "Normal");
            logger.message('Configuring can be re-attempted with "Autotools: Configure"', "Normal");
            logger.message('KB: ' + kbUrl.toString(true) + '#config-fail', "Normal");
        }
        return success;
    };
    public isAutotoolsProject(): boolean { return !!configuration.getConfigureAc(); }
    public isBootstrapped(): boolean { return this.autotoolsTask.isBootstrapped(); }
    public isConfigured(): boolean { return this.autotoolsTask.isConfigured(configuration.getCurrentMakefileConfiguration()); }

    public updateMakefileFilePresent(newValue: boolean): void {
        vscode.commands.executeCommand("setContext", "autotools:makefileFilePresent", newValue);
    }

    public getState(): state.StateManager { return this.mementoState; }

    public dispose(): void {
        this._projectOutlineTreeView?.dispose();
        this._projectTestSuitesView?.dispose();
        this._treeDisposables.forEach((d) => d.dispose());
        this.configDisposables.forEach((d) => d.dispose());
        if (this.cppToolsAPI) {
            this.cppToolsAPI.dispose();
        }
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
        } else {
            let kbUrl = await extension.kbUrl();
            logger.message('C/C++ Intellisense is not loaded. Install an extension to enable syntax highlighting and completions.', "Normal");
            logger.message('KB: ' + kbUrl.toString(true) + '#intellisense-not-loaded', "Normal");
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
    public updateCppToolsProvider(): number {
        if (this.cppToolsAPI) {
            this.cppConfigurationProvider.logConfigurationProviderBrowse();
            this.cppToolsAPI.didChangeCustomConfiguration(this.cppConfigurationProvider);
        }
        return 0;
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

export async function openEditor(file: string) {
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
        let uri = vscode.Uri.file(resolvePathToRoot(path.join(top_builddir, logfile)));
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
    let teleParams = await tele.getParams();
    extension = new Extension(context, teleParams);

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildConfiguration', async () => {
        if (!configuration.getCurrentMakefileConfiguration().top_builddir && extension.isConfigured()) {
            const doit: string = localize("autotools.switch.to.out.of.tree", "Browse doc page");
            vscode.window.showErrorMessage(
                localize("autotools.want.out-of-tree", "The project needs to be switched to out-of-tree build mode."),
                doit,
                localize("autotools.cancel", "Cancel")).then((value) => {
                if (value === doit) {
                    // this.autotoolsTask.bootstrap();
                    vscode.commands.executeCommand('vscode.open', "https://autotools.mergesium.com/kb/docs/#switch-to-out-of-tree-configuration");
                }
            });
        // https://github.com/microsoft/vscode/blob/0bb69da87ca19412a768d5966fcb0e7b36b2dd3f/src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts#L277
            // await vscode.commands.executeCommand('extension.open', context.extension.id, 'readme', true);
            // await vscode.commands.executeCommand('extension.open', "ms-vscode-remote.remote-ssh");
            // await vscode.commands.executeCommand('extension.open', "ms-vscode-remote.remote-ssh#getting-started");
            // vscode.commands.executeCommand('vscode.open', "https://autotools.mergesium.com/doc/switch-to-out-of-tree-configurations");
        } else {
            await configuration.setNewConfiguration();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getConfiguration', async () => {
        telemetry.logEvent("getConfiguration");
        return configuration.getCurrentMakefileConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.goal', async () => {
        telemetry.logEvent("goal");
        return (await configuration.getCurrentTarget()).goal;
    }));

    /* also need top_builddir */
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

    context.subscriptions.push(vscode.commands.registerCommand('autotools.addAutotools', async () => {
        telemetry.logEvent("addAutotools");
        await installAutotools();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent("outline.buildAll");
        if (sub instanceof tree.SubNode)
            extension.build(new make.BuildTarget(sub.submake.dir, make.t_all.goal));
        else
            extension.build(make.t_all);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent("buildAll");
        if (sub instanceof tree.SubNode)
            extension.build(new make.BuildTarget(sub.submake.dir, make.t_all.goal));
        else
            extension.build(make.t_all);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.checkAll', async () => {
        extension.build(make.t_check);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.checkAll', async () => {
        extension.build(make.t_check);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.exportToIntelisense', async () => {
        await make.configure(make.TriggeredBy.configure);
    }));

    // Reset state - useful for troubleshooting.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.resetState', () => {
        telemetry.logEvent("commandResetState");
        extension.getState().reset();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.recheck', () => {
        telemetry.logEvent("recheck");
        extension.recheck(false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        telemetry.logEvent("configure");
        extension.configure();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.build', async (sub: tree.TaskNode) => {
        telemetry.logEvent("build");
        if (!sub.goal?.task)
            throw new Error("Missing build task on TaskNode");
        if (sub.goal.task instanceof vscode.Task)
            return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.livecheck', async (sub: tree.SubNode) => {
        telemetry.logEvent("livecheck");
        /* Must be a SubNode */
        if (!sub.submake.test_suite)
            throw new Error("Missing test suite on SubNode");
        if (!sub.submake.test_suite.task)
            throw new Error("Missing check task on SubNode");
        assert(sub.submake.test_suite.task instanceof Map, "test_suite.task should be a Map", sub.submake.test_suite.task);
        sub.submake.test_suite.test &&
            extension.testController?.togglelivecheck(sub.submake.test_suite.test);
            // return await vscode.tasks.executeTask(sub.submake.test_suite.test);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.check', async (sub: tree.SubNode) => {
        telemetry.logEvent("check");
        /* Must be a SubNode */
        if (!sub.submake.test_suite)
            throw new Error("Missing test suite on SubNode");
        if (!sub.submake.test_suite.task)
            throw new Error("Missing check task on SubNode");
        assert(sub.submake.test_suite.task instanceof Map, "test_suite.task should be a Map", sub.submake.test_suite.task);
        sub.submake.test_suite.test &&
            extension.testController?.run(sub.submake.test_suite.test, configuration.getCurrentTestEnvironment());
            // return await vscode.tasks.executeTask(sub.submake.test_suite.test);
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
        if (sub.goal.test && extension.testController)
            return await extension.testController.run(sub.goal.test, configuration.getCurrentTestEnvironment());
        //return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.debug', async (sub: tree.TaskNode) => {
        telemetry.logEvent("debug");
        if (!sub.goal.task)
            throw new Error("Missing test task on TaskNode");
        if (sub.goal.test && extension.testController)
            extension.testController.debug(sub.goal.test, configuration.getCurrentTestEnvironment());

//        const definition: TestTask = <any>sub.goal.task.get.definition;
//            if (definition?.type == 'test' && sub.goal && definition.test)
//                extension.debugGoal(sub.goal, definition.test.builddir, configuration.getProjectTestEnvironment());
//        }
        // return await vscode.tasks.executeTask(sub.goal.task);
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
    if (extension.isAutotoolsProject()) {
        statusBar.show();
        configuration.initFromState();
        await configuration.initFromSettings(true);
        await outputLogHeader();
    }

    const openFile = async (fileUri: vscode.Uri) => {
        await vscode.commands.executeCommand("vscode.open", fileUri);
        await vscode.commands.executeCommand("workbench.files.action.showActiveFileInExplorer");
    }

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (f) => {
        if (extension.testController) {
            vscode.workspace.textDocuments.find((d) => d.isDirty) ||
            await extension.testController?.onSavedAll();
        }
    }));

    // context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors( (editors) => {
    //     // logger.message(`Opened file ${.uri}`, "Normal");
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(async (tabs) => {
        if (
            (tabs.opened &&
                tabs.opened.find(t => (t.input instanceof vscode.TabInputText) &&  t.input.uri.scheme === "file")) ||
            (tabs.closed &&
                    tabs.closed.find(t => (t.input instanceof vscode.TabInputText) &&  t.input.uri.scheme === "file"))
            )
            await extension.testController?.onOpenedDocument();
    }));

    extension.registerTasks();

    if (vscode.workspace.workspaceFolders) {
        let configureAc = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], (configuration.getConfigureAc() || "configure.ac")));
        context.subscriptions.push(configureAc.onDidChange(async (e) => await extension.recheck(true)));
        context.subscriptions.push(configureAc.onDidCreate(async (e) => await extension.recheck(true)));
        context.subscriptions.push(configureAc.onDidDelete(async (e) => await extension.recheck(true)));
    }

    vscode.window.registerFileDecorationProvider(extension.suiteDecorator);

    if (!configuration.getConfigurationMakefile()) {
        ui.getUI().setLoading(extension.isAutotoolsProject() ? ui.UIStatus.ERR : ui.UIStatus.NON_AUTOTOOLS);
        return;
    }
    await make.configure(make.TriggeredBy.cleanConfigure);
}

export async function outputLogHeader() : Promise<void> {

    var kburl = await extension.kbUrl();
    if (extension.pkginfo/* && !currentMakefileConfiguration*/) {
        let pkg = extension.pkginfo;
        logger.message(localize('autotools.package.coordinates', "Package \"{0}\" version {1} - bug reports: {2}, url: {3}",
        pkg.name || "unknown", pkg.version || "unk", pkg.bugreport || "unknown", pkg.url || "unknown"), "Normal");
        logger.message(localize('autotools.ref.kb', "Knowledge Base: {0}", kburl.toString(true)), "Normal");
        logger.message("=======================", "Normal");
    }
    return Promise.resolve();
}

export async function deactivate(): Promise<void> {
    vscode.window.showInformationMessage(localize("extension.deactivated", "The extension {0} is de-activated.", "'vscode-makefile-tools'"));

    await telemetry.deactivate();

    const items : any = [
        extension,
        telemetry,
        statusBar
    ];

    for (const item of items) {
        if (item) {
            item.dispose();
        }
    }
    return Promise.resolve();
}

function countStats(sub: gnumake.Make): number[] {
    sub.stats.subdirs = sub.submake.size;
    for (let submake of sub.submake.values()) {
        let [t, n, s, c] = countStats(submake);
        sub.stats.programs += t;
        sub.stats.tests += n;
        sub.stats.subdirs += s;
        sub.stats.checks += c;
    }
    for (let [goal, g] of sub.goals)
        sub.stats.programs += ((g.flags & Goal.Flags.Linked_binary)
            && !(g.flags & Goal.Flags.Test_Program)) ? 1 : 0;

    let numTestsHere = (sub.goals.get("test-suite.log")?.depends?.length ?? 0);
    sub.stats.tests += numTestsHere;
    sub.stats.checks += (numTestsHere ? 1 : 0);
    return [
        sub.stats.programs,
        sub.stats.tests,
        sub.submake.size,
        sub.stats.checks
    ];
}
