// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Makefile Tools extension

import * as configuration from './configuration';
import { FolderConfig, MakefileConfiguration, TestEnvironment } from './configuration';
import * as cpptools from './cpptools';
import * as logger from './logger';
import * as util from './util';
import * as make from './make';
import { TRS } from './make';
import * as gnumake from './parser/gnumake';
import { Goal } from './parser/gnumake';
import * as path from 'path';
import { SpanStatusCode, getStartTime } from './tele';
import {
    ProjectOutlineProvider,
    ProjectTestsProvider,
    subHash,
    } from './tree';
import * as tree from './tree';
import * as ui from './ui';
import * as vscode from 'vscode';
import { TestItem } from 'vscode';
import * as cpp from 'vscode-cpptools';
import { CppConfigurationProvider } from './cpptools';
import * as debugProvider from './debug';
import { DebugNow } from './debug';
import {
        AutotoolsTask,
        TestTask,
        BuildTask,
        CheckTask,
        MyTaskProvider,
        AutoToolsCheckTaskProvider} from './tasks';
import { SuiteDecorations, URIFolderIndexRe } from './suite-decorator';
import { TestGrid, GridShowOptions } from './testgrid';
import * as tele from './tele';
import * as nls from 'vscode-nls';
import { assert } from 'console';
import { installAutotools } from './install';
import { Span } from '@opentelemetry/api';
import { buildinfo } from '../buildinfo';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export const statusBar: ui.UI = ui.getUI();

export let extension: Extension;
export let telemetry: tele.MyTelemetry;

const ignoredSaveFiles : Set<string> = new Set(
    ["settings.json", "tasks.json", "launch.json",
    "configure.ac", "Makefile.am"]);
const rdepRevealOption : { select: boolean,
        expand: number,
        focus: boolean } = {select: false, expand: 3, focus: false};
export class Extension {
    static readonly whoami: string = "mergesium.autotools";
    static readonly myVersion = 0;

    public readonly journey;
    public readonly _projectOutlineProvider;
    public readonly _projectTestSuitesProvider;
    public _projectOutlineTreeView : vscode.TreeView<tree.Node> | undefined;
    private _expandedMakes: Map<number,Set<number>> = new Map();
    public _projectTestSuitesView : vscode.TreeView<tree.Node> | undefined;
    private _expandedChecks: Map<number,Set<number>> = new Map();
    public readonly suiteDecorator = new SuiteDecorations();

    public cppToolsAPI?: cpp.CppToolsApi;
    public needTaskFetchBugWorkaround: boolean = true;
    private compilerFullPath ?: string;
    public readonly dryRunner : string;
    public readonly testRunner : string;
    public readonly ltLauncher : string;
    public readonly rulesPath : string;
    public readonly m4Path : string;
    public readonly userEnvName : string = "<none>";
    private _treeDisposables: vscode.Disposable[] = [];
    public running: WeakMap<vscode.TaskExecution, Span> = new WeakMap();

    /* Intellisense Data */
    private readonly _cppConfigurationProvider : CppConfigurationProvider = new CppConfigurationProvider();
    public get cppConfigurationProvider() : CppConfigurationProvider { return this._cppConfigurationProvider; }


    public constructor(public readonly extensionContext: vscode.ExtensionContext, teleParams: tele.Params) {
        telemetry = new tele.MyTelemetry(extensionContext, teleParams);
        this.journey = telemetry.startSpan('j');

        this._projectOutlineProvider = new ProjectOutlineProvider();
        this._projectTestSuitesProvider = new ProjectTestsProvider(); // <null>

        this.dryRunner = path.join(extensionContext.extensionPath, "bin/make" + (process.platform === 'win32' ? ".exe" : ""));
        this.testRunner = path.join(extensionContext.extensionPath, "bin/test-driver");
        this.ltLauncher = path.join(extensionContext.extensionPath, "bin/lt-debug.sh");
        this.rulesPath = path.join(extensionContext.extensionPath, "include")
        this.m4Path = path.join(extensionContext.extensionPath, "m4")

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.bootstrap', async () => {
            telemetry.logEvent(this.journey, "cBs");
            await configuration.selectFolderConfig().then(
                async fc => await fc.autotoolsTask.bootstrap()
                    .then(te => this.running.set(te, extension.journey))
            )
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.outline.bootstrap', async (sub: tree.SubNode) => {
            telemetry.logEvent(this.journey, "cBs");
            await sub.make.ctx.fc.autotoolsTask.bootstrap()
                    .then(te => this.running.set(te, extension.journey));
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.regen', async () => {
            telemetry.logEvent(this.journey, "cRegen");
            await configuration.selectFolderConfig().then(
                async fc => await fc.autotoolsTask.regen()
            );
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.configure.help', async () => {
            telemetry.logEvent(this.journey, "cHelp");
            await configuration.selectFolderConfig().then(
                async fc => await fc.autotoolsTask.help()
            );
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.knowledgeBase', async () => {
            telemetry.logEvent(this.journey, "gKB");
            await configuration.selectFolderConfig().then(
                async fc => await fc.gotoKnowledgeBase()
            );
        }));
        /* TODO: Rework this command */

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.packageURL', async () => {
            telemetry.logEvent(this.journey, "gpU");
            await configuration.selectFolderConfig().then(
                async fc => {
                    if (fc.pkginfo?.url)
                        vscode.commands.executeCommand('vscode.open', fc.pkginfo.url);
            });
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.gotoBuildDirectory', async (goal: Goal) => {
            telemetry.logEvent(this.journey, "gBD");
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.from({
                scheme: 'file',
                path: goal.make.ctx.root
            }));
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.C_Cpp.ConfigurationProviderSelect', () => {
            telemetry.logEvent(this.journey, "cppProv");
            vscode.commands.executeCommand('C_Cpp.ConfigurationProviderSelect');
        }));

        /* TODO: Rework this command */
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.packageBugs', async (sub: tree.SubNode) => {
            telemetry.logEvent(this.journey, "gpBugs");
            if (sub.make.ctx.fc.pkginfo?.bugreport)
                vscode.commands.executeCommand('vscode.open', sub.make.ctx.fc.pkginfo.bugreport);
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.openKnowledgeBase', async (sub: tree.SubNode) => {
            telemetry.logEvent(this.journey, "gKB");
            await sub.make.ctx.fc.gotoKnowledgeBase()
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.testgrid.top', async (sub: tree.SubNode | TestItem) => {
            telemetry.logEvent(this.journey, "topgrid");
            if (sub instanceof tree.SubNode /*&& sub.make.test_suite*/) {
                // dir = sub.make.dir;
                let fc = sub.make.ctx.fc;
                let summary : vscode.Uri = vscode.Uri.from({
                    scheme: TestGrid.scheme,
                    authority: "mergesium.autotools",
                    path: path.resolve('/', fc.folder.index.toString(), TestGrid.top),
                });
                await focusPreviewedDocument(summary);
            } else if (instanceOfTestItem(sub)) {
                let dir = URIFolderIndexRe.exec(sub.parent?.id ?? sub.id);
                if (dir) {
                    let summary : vscode.Uri = vscode.Uri.from({
                        scheme: TestGrid.scheme,
                        authority: "mergesium.autotools",
                        path: `/${dir[1]}/${TestGrid.top}`,
                    });
                    await focusPreviewedDocument(summary);
                }
            }
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.testgrid.item', async (sub: tree.SubNode | TestItem) => {
            telemetry.logEvent(this.journey, "itemgrid");
            let dir : string | undefined;
            let fc : FolderConfig;
            if (sub instanceof tree.SubNode && sub.make.test_suite) {
                dir = sub.make.dir;
                fc = sub.make.ctx.fc;
                let summary : vscode.Uri = vscode.Uri.from({
                    scheme: TestGrid.scheme,
                    authority: "mergesium.autotools",
                    path: path.resolve('/', fc.folder.index.toString(), dir),
                });
                await focusPreviewedDocument(summary);
            } else if (instanceOfTestItem(sub)) {
                //dir = sub.parent?.id ?? sub.id;
                let dir = sub.children.size ? sub.id : sub.parent?.id;
                if (dir) {
                    let summary : vscode.Uri = vscode.Uri.from({
                        scheme: TestGrid.scheme,
                        authority: "mergesium.autotools",
                        path: `${dir}`,
                    });
                    await focusPreviewedDocument(summary);
                }
            }
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.rdepends', async (sub: vscode.Uri) => {
            if (!(sub instanceof vscode.Uri))
                return Promise.reject("Expected file Uri argument");
            let span = telemetry.startSpan("rdep", extension.journey);
            configuration.setCurrentGoalBins(undefined);
            configuration.setCurrentGoalTests(undefined);
            vscode.commands.executeCommand('autotools.tests.focus');
            let goals = extension._projectOutlineProvider.selectRdepends(sub);
            let status : boolean = true;
            for (const g of goals) {
                if (g.flags & Goal.Flags.Test_Log) {
                    extension._projectTestSuitesProvider.all.set(g.getFilePath(), g); // Fixme - this cn be moved to Test Tree build parents, it seems out of place here. Here it does lazy allocation, in buildParents it would be eager allocation
                    await extension._projectTestSuitesView?.reveal(g, rdepRevealOption) // rdepRevealOption)
                    .then(() => {},
                    err => {
                        status = false;
                        logger.message(`ERROR: Internal error finding goal ${g.goal} in tests tree`,'Normal');
                        telemetry.logException(new Error(`No ${g.goal} in test tree`), extension.journey);
                    })
                } else {
                    extension._projectOutlineProvider.all.set(g.getFilePath(), g); // Fixme - this cn be moved to Test Tree build parents, it seems out of place here. Here it does lazy allocation, in buildParents it would be eager allocation
                    await this._projectOutlineTreeView?.reveal(g, rdepRevealOption)
                    .then(() => {},
                    err => {
                        status = false;
                        logger.message(`ERROR: Internal error finding goal ${g.goal} in programs tree`,'Normal');
                        telemetry.logException(new Error(`No ${g.goal} in bin tree`), extension.journey);
                    });
                }
            }
            this.suiteDecorator.highlightTargets(goals, sub.path);
            telemetry.endSpanWithStatus(span, status ? SpanStatusCode.OK : SpanStatusCode.ERROR, undefined, { numrd: goals.length });
            return Promise.resolve();
        }));

        debugProvider.activate(extensionContext);
    }
    public createPanel() : void {
        if (this._projectOutlineTreeView)
            return; // otherwise "No tree view id 'autotools.outline' registered rejected promise wehn
        this._projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
            treeDataProvider: this._projectOutlineProvider,
            canSelectMany: true,
            showCollapseAll: false

        });
        this._treeDisposables.push(this._projectOutlineTreeView.onDidChangeSelection(e => {
            let oldGoals = configuration.currentGoalsBins;
            if (e.selection.length > 0) {
                let newGoals = e.selection.filter(g => g instanceof Goal) as Goal[];
                configuration.setCurrentGoalBins(newGoals.length ? newGoals : undefined);
            } else {
                configuration.setCurrentGoalBins(undefined);
            }
            if (oldGoals != configuration.currentGoalsBins) {
                this.suiteDecorator.highlightRelevant(configuration.currentGoals);
            }
        }));
        this._treeDisposables.push(this._projectOutlineTreeView.onDidCollapseElement((e: vscode.TreeViewExpansionEvent<tree.Node>) => {
            let s = this._expandedMakes.get(e.element.make.ctx.fc.folder.index);
            if (!s) {
                s = new Set(e.element.make.ctx.fc.state.expandedMakes);
                this._expandedMakes.set(e.element.make.ctx.fc.folder.index,s);
            }
            s.delete(subHash(e.element as tree.SubNode));
            e.element.make.ctx.fc.state.expandedMakes = Array.from(s);
        }));
        this._treeDisposables.push(this._projectOutlineTreeView.onDidExpandElement((e: vscode.TreeViewExpansionEvent<tree.Node>) => {
            let s = this._expandedMakes.get(e.element.make.ctx.fc.folder.index);
            if (!s) {
                s = new Set(e.element.make.ctx.fc.state.expandedMakes);
                this._expandedMakes.set(e.element.make.ctx.fc.folder.index,s);
            }
            s.add(subHash(e.element as tree.SubNode));
            e.element.make.ctx.fc.state.expandedMakes = Array.from(s);
        }));

        this._projectTestSuitesView = vscode.window.createTreeView('autotools.tests', {
            treeDataProvider: this._projectTestSuitesProvider,
            canSelectMany: true,
            showCollapseAll: false
        });
        this._treeDisposables.push(this._projectTestSuitesView.onDidChangeSelection((e) => {
            let oldGoals = configuration.currentGoalsTests;
            if (e.selection.length > 0) {
                let newGoals = e.selection.filter(g => g instanceof Goal) as Goal[];
                configuration.setCurrentGoalTests(newGoals.length ? newGoals : undefined);
            } else {
                configuration.setCurrentGoalTests(undefined);
            }
            if (oldGoals != configuration.currentGoalsTests) {
                this.suiteDecorator.highlightRelevant(configuration.currentGoals);
            }
            if (e.selection.length > 0) {
                let selected = e.selection[0];
                if (selected instanceof tree.Node && !(selected instanceof tree.SubNode)) {
                    return openLog(selected);
                }
            }
        }));
        this._treeDisposables.push(this._projectTestSuitesView.onDidCollapseElement((e: vscode.TreeViewExpansionEvent<tree.Node>) => {
            let s = this._expandedChecks.get(e.element.make.ctx.fc.folder.index);
            if (!s) {
                s = new Set(e.element.make.ctx.fc.state.expandedChecks);
                this._expandedChecks.set(e.element.make.ctx.fc.folder.index,s);
            }
            s.delete(subHash(e.element as tree.SubNode));
            e.element.make.ctx.fc.state.expandedChecks = Array.from(s);
        }));
        this._treeDisposables.push(this._projectTestSuitesView.onDidExpandElement((e: vscode.TreeViewExpansionEvent<tree.Node>) => {
            let s = this._expandedChecks.get(e.element.make.ctx.fc.folder.index);
            if (!s) {
                s = new Set(e.element.make.ctx.fc.state.expandedChecks);
                this._expandedChecks.set(e.element.make.ctx.fc.folder.index,s);
            }
            s.add(subHash(e.element as tree.SubNode));
            e.element.make.ctx.fc.state.expandedChecks = Array.from(s);
        }));
    }
    public deletePanel() : void {
        this._treeDisposables.forEach((d) => d.dispose());
        this._projectOutlineTreeView?.dispose();
        this._projectTestSuitesView?.dispose();
        this._projectOutlineTreeView = undefined;
        this._projectTestSuitesView = undefined;
        this._treeDisposables = [];
}

    /**
     * Handler for TRS file changes. Updates the Goal's trs structure with the current and global results
     * @param c {@linkcode MakefileConfiguration Current build configuration}
     * @param env {@linkcode TestEnvironment} The TestEnvironment that is the "current", used to select the right :test-result: TRS line
     * @param uri the uri of the TRS file as reported by fs.watch
     */
    trsChange(fc: FolderConfig, uri: vscode.Uri) : void {

        /* The test driver moves the trs to trs.tmp when generating a new one. Avoid test status updating to 'NONE'
         * while tests are running.
         */
        if (fc.testController?.busyNonLiveTest)
            return;
        /* This is only used when the FS changes without a testRun in progress */
        let dir = path.relative(fc.abs_top_builddir, path.dirname(uri.path));
        let log = path.basename(uri.path, ".trs") + ".log";
        let goal = fc.buildTargets
            ?.get(dir)
            ?.get('test-suite.log')
            ?.depends?.find((d) => d.goal === log);

        if (goal) {
            let old = goal.trs;
            let old_global = goal.trs?.global ?? TRS.NONE;
            goal.trs = make.readTRS(new make.BuildTarget(dir, log), fc);

            if (fc.updateTRSInPanel(old, goal, dir))
                fc.updateOutlineBadge();

            if ( ((goal.test && goal.trs.global != old_global) || fc.testController?.busy) && !(goal.flags & Goal.Flags.Test_Suite))
                /* If there is an active test run, use it to log the TRS result.
                 * Otherwise, create a new manual run
                 */
                if (!fc.testController?.markActiveTestTRS(goal, dir))
                    goal.test && fc.testController?.trsChange(goal.test, dir);
        }
    }

    public registerTasks(): void {
        // It's possible that the fileWatcher takes too many descriptors, so
        // it might be replaced with waiting for exit codes.
        // Monitoring exit codes is blind to the user manually doing "make clean" or "make check"
        this.extensionContext.subscriptions.push(vscode.tasks.onDidEndTask((e) =>{
            let task = e.execution.task;
            // let span = this.running.get(e.execution);
            this.running.delete(e.execution);
            if (task && ('folderIndex' in task.definition)) {
                const definition: TestTask = <any>task.definition;
                if (definition.folderIndex < 0) // ie, bug workaround
                    return;
                let fc = configuration.findFolderConfigByIndex(definition.folderIndex);
                if (definition.type == "test" && definition.test) {
                    let suite = fc.buildTargets
                        .get(definition.test.builddir)
                        ?.get('test-suite.log');
                    if (suite) {
                        let goal = suite.depends?.find((d) => d.goal === definition.test?.goal);
                        if (goal) {
                            definition.test && goal.test && fc.testController!.testCompleted(e.execution, goal, definition.test);
                        }
                    }
                    fc.autotoolsTask.autotoolsDoneNoResult();
                    extension.updateAllGrids();
                } else if (definition.type == 'check') {
                    const def: CheckTask = task.definition as CheckTask;
                    let suite = fc.buildTargets
                        .get(def.builddir)
                        ?.get('test-suite.log');
                    if (suite && suite.test) {
                        fc.testController?.suiteCompleted(e.execution, suite, def.builddir);
                    }
                    fc.autotoolsTask.autotoolsDoneNoResult();
                    extension.updateAllGrids();
                } else if (definition.type == "autotools") {
                    fc.autotoolsTask.autotoolsDoneNoResult();
                }
            }
        }));
        this.extensionContext.subscriptions.push(vscode.tasks.onDidEndTaskProcess(async (e) => {
            let task = e.execution.task;
            if (task) {
                let tspan = this.running.get(e.execution);
                let span = tspan ?? extension.journey;
                const definition: TestTask = <any>task.definition;
                if (definition.type == "test" && definition.test) {
                    definition.exitCode = e.exitCode;
                } else if (definition.type == 'check') {
                    definition.exitCode = e.exitCode;
                } else if (definition.type == "autotools") {
                    const definition: AutotoolsTask = <any>task.definition;

                    let fc = configuration.findFolderConfigByIndex(definition.folderIndex);
                    ui.getUI().setStatus(e.exitCode ? ui.UIStatus.ERR : ui.UIStatus.OK, fc);
                    await fc.taskFSM(e, definition, span, task);
                }
                tspan?.end();
            }
        }));
        this.extensionContext.subscriptions.push(vscode.debug.onDidStartDebugSession(e => {
            let type = e.configuration.testUri ?
                (e.configuration.testUri.scheme == "test" ? "debugT" : "debugR") : "debug";
            if (e.workspaceFolder) {
                let fc = configuration.getFolderConfig(e.workspaceFolder);
                fc.testController?.debugStarted(e, type);
            }
        }));
        this.extensionContext.subscriptions.push(vscode.debug.onDidTerminateDebugSession(e => {
            if (e.workspaceFolder) {
                let fc = configuration.getFolderConfig(e.workspaceFolder);
                fc.testController?.debugEnded(e);
            }
        }));
    }
    tasksBugWorkaround() : void {
        if (this.needTaskFetchBugWorkaround) {
            // FIXME: This is a workaround for vscode not parsing tasks.json prior to fetchTasks()
            const kind:BuildTask = {
                folderIndex: -1,
                type: "build",
                target: new make.BuildTarget(".", "fetchTasks-bug-workaround")
            };
            let workaroundTask = new vscode.Task(kind, vscode.TaskScope.Workspace, 'autotools', 'autotools',
            new vscode.ProcessExecution("true", ["this-is-a-workaround-for-fetchTasks-bug-not-parsing-tasks-json"]));
            workaroundTask.presentationOptions = {
                reveal: vscode.TaskRevealKind.Never,
                focus: false,
                panel: vscode.TaskPanelKind.Shared,
                showReuseMessage: false};
            workaroundTask.isBackground = true;
            vscode.tasks.executeTask(workaroundTask);
        }
    }

    public readonly projectTestGrid = new TestGrid();
    public updateAllGrids() : void {
        this.projectTestGrid.updateAll();
    }

    // goal is the *.log goal. The executable will be read from .depends[0]
    async debugGoal(goal: Goal, env: configuration.TestEnvironment) : Promise<void> {
        if (goal?.depends?.length && goal.depends[0].goal) {
            this.journey.addEvent("deb");
            let dopt : vscode.DebugSessionOptions = {
                compact: true
            };
            try {
                vscode.debug.startDebugging(
                    goal.make.ctx.fc.folder,
                    new DebugNow(goal, goal.depends[0], env),
                    dopt)
                .then((z) => {});
            } catch(e) {
                logger.message(`ERROR: Failed to start debugging: ${e}`);
            }
        } else
            this.journey.addEvent("debNoS");
    }

    // public onConfigurationSelect(c: MakefileConfiguration) : void {
    //     this.tasks.forEach((provider) => provider.changeConfiguration(c));
    //     this.configDisposables.forEach((d) => d.dispose());
    //     this.configDisposables = [];
    // }
    //public bootstrap(span: Span): void {
    //    this.autotoolsTask.bootstrap();
    //}
    //public async reautomake(span: Span): Promise<void> {
    //    await this.autotoolsTask.reautomake(span);
    //}
    // config.status (just re-output)
    // public async regen(): Promise<void> { await this.autotoolsTask.regen(); }
    // config.status --recheck
//    public async recheck(span: Span): Promise<void> {
//        await this.autotoolsTask.recheck(span);
//        return Promise.resolve();
//    }
    //public autotoolsDoneNoResult(): void { this.autotoolsTask.autotoolsDoneNoResult(); }
    //public async waitToTouchMakefiles(): Promise<void> { await this.autotoolsTask.waitToTouchMakefiles(); }

    //public build(target: make.BuildTarget): void { this.buildTasks.build(target); }
    //public async checkAll(): Promise<void> { await this.checkTasks.checkAll(); }
    // public isBootstrapped(): boolean { return this.autotoolsTask.isBootstrapped(); }
    // public isConfigured(): boolean { return this.autotoolsTask.isConfigured(configuration.getCurrentMakefileConfiguration()); }

    public dispose(): void {
        this.deletePanel();
        if (this.cppToolsAPI) {
            this.cppToolsAPI.dispose();
        }
        this.journey.end();
    }

    // Used for calling cppToolsAPI.notifyReady only once in a VSCode session.
    private ranNotifyReadyInSession: boolean = false;
    public getRanNotifyReadyInSession() : boolean { return this.ranNotifyReadyInSession; }
    public setRanNotifyReadyInSession(ran: boolean) : void { this.ranNotifyReadyInSession = ran; }

    // Similar to state.ranConfigureInCodebaseLifetime, but at the scope of a VSCode session
    private completedConfigureInSession: boolean = false;
    public getCompletedConfigureInSession() : boolean | undefined { return this.completedConfigureInSession; }
    public setCompletedConfigureInSession(completed: boolean) : void { this.completedConfigureInSession = completed; }

    public getCppToolsVersion(): cpp.Version | undefined {
        return this.cppToolsAPI?.getVersion();
    }

    public async registerCppTools(): Promise<void> {
        this.cppToolsAPI = await cpp.getCppToolsApi(cpp.Version.v6);
    // Register this folder as a new provider or request an update
        if (this.cppToolsAPI) {

            // Call notifyReady earlier than when the provider is updated,
            // as soon as we know that we are going to actually parse for IntelliSense.
            // This allows CppTools to ask earlier about source files in use
            // and Makefile Tools may return a targeted source file configuration
            // if it was already computed in our internal arrays (make.ts: customConfigProviderItems).
            // If the requested file isn't yet processed, it will get updated when configure is finished.
            // TODO: remember all requests that are coming and send an update as soon as we detect
            // any of them being pushed into make.customConfigProviderItems.
            extension.cppToolsAPI?.registerCustomConfigurationProvider(this._cppConfigurationProvider);
            extension.cppToolsAPI?.notifyReady(this._cppConfigurationProvider);
        }
    }
    // Request a custom config provider update.
    public updateCppToolsProvider(): void {
        if (extension.cppToolsAPI) {
            this._cppConfigurationProvider.logConfigurationProviderBrowse();
            extension.cppToolsAPI.didChangeCustomConfiguration(this._cppConfigurationProvider);
        }
    }


    public getCompilerFullPath() : string | undefined { return this.compilerFullPath; }

    private isActive: boolean = false;
    readonly _activatedEvent: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
    async waitActivated() : Promise<boolean> {
        if (this.isActive)
            return Promise.resolve(this.isActive);
        return new Promise<boolean>(resolve => {
            let a = this._activatedEvent.event(e => {
                a.dispose();
                return resolve(e);
            });
        });
    }
}

export async function openSettings(setting: string, folder: vscode.WorkspaceFolder | null, json: boolean) : Promise<void> {
//    await vscode.commands.executeCommand("workbench.action.openSettings", setting);
    await vscode.commands.executeCommand(json ? "workbench.action.openWorkspaceSettings" : "workbench.action.openWorkspaceSettingsFile", {
        query: setting,
        openToSide: false,
        focusSearch: true});
}

export async function openEditor(file: string) : Promise<void> {
    await vscode.workspace.openTextDocument(file).then(
        doc => vscode.window.showTextDocument(doc, { preview: true})
        );
}

function openLog(selected: tree.Node): Thenable<vscode.TextDocument> {
    //let top_builddir =
    //    configuration.getCurrentMakefileConfiguration().top_builddir;
    let logfile = selected.logfile();
    if (logfile) {
        let uri = vscode.Uri.file(path.join(selected.make.ctx.fc.abs_top_builddir, logfile));
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
    let act : Span | undefined = undefined;
    try {
    let teleParams = await tele.getParams();
    extension = new Extension(context, teleParams);
    let validact = telemetry.startSpan('act', extension.journey);
    act = validact;

    context.subscriptions.push(vscode.commands.registerCommand('autotools.locateMakefile', async (a: string[]) => {
        let fc = configuration.findFolderConfig(vscode.Uri.file(a[0]));
        if (fc) {
            if (fc.lastTaskMakeDir) {
                return fc.lastTaskMakeDir;
            }
            return fc.abs_top_builddir;
        }
        return Promise.reject('unknown location');
    }));
    /** End of commands that shouldn't be exposed in package.json, they are used for command substitution in launch.json and tasks.json. */

    context.subscriptions.push(vscode.commands.registerCommand('autotools.addAutotools', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "aa");
        await installAutotools(sub.make.ctx.fc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "obA");
        if (sub instanceof tree.SubNode)
            sub.make.ctx.fc.buildTasks.build(new make.BuildTarget(sub.make.dir, make.t_all.goal));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "ba");
        if (sub instanceof tree.SubNode)
            sub.make.ctx.fc.buildTasks.build(new make.BuildTarget(sub.make.dir, make.t_all.goal));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.checkAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "ocA");
        if (sub instanceof tree.SubNode)
            await sub.make.ctx.fc.checkTasks.checkAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.checkAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "ckA");

        if (sub instanceof tree.SubNode)
            return sub.make.ctx.fc.testController?.manualRun(false, undefined, sub.make.ctx.fc.currentTestEnvironment);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.exportToIntelisense', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "exp");
        if (sub instanceof tree.SubNode)
            await make.configure(extension.journey, make.TriggeredBy.configure, sub.make.ctx.fc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.recheck', (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "orc");
        if (sub instanceof tree.SubNode)
            sub.make.ctx.fc.autotoolsTask.recheck(telemetry.startSpan('recheck', extension.journey));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.configure', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "oc");
        if (sub instanceof tree.SubNode)
            sub.make.ctx.fc.configure(extension.journey);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        telemetry.logEvent(extension.journey, "c");
        await configuration.selectFolderConfig().then( async fc => {
            await fc.configure(extension.journey)
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.build', async (goal: Goal) => {
        telemetry.logEvent(extension.journey, "b");
        if (!goal.task)
            throw new Error("Missing build task on TaskNode");
        if (goal.task instanceof vscode.Task) {
            goal.make.ctx.fc.lastTaskMakeDir = goal.make.getDir();
            return await vscode.tasks.executeTask(goal.task);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.livecheck', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "lc");
        /* Must be a SubNode */
        if (!sub.make.test_suite)
            throw new Error("Missing test suite on SubNode");
        if (!sub.make.test_suite.task)
            throw new Error("Missing check task on SubNode");
        assert(sub.make.test_suite.task instanceof Map, "test_suite.task should be a Map", sub.make.test_suite.task);
        sub.make.test_suite.test &&
            sub.make.ctx.fc.testController?.togglelivecheck(sub.getTreeItem(vscode.TreeItemCollapsibleState.Expanded),sub.make.test_suite.test);
            // return await vscode.tasks.executeTask(sub.submake.test_suite.test);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.check', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "ck");
        /* Must be a SubNode */
        if (!sub.make.test_suite)
            throw new Error("Missing test suite on SubNode");
        if (!sub.make.test_suite.task)
            throw new Error("Missing check task on SubNode");
        assert(sub.make.test_suite.task instanceof Map, "test_suite.task should be a Map", sub.make.test_suite.task);
        sub.make.test_suite.test &&
            sub.make.ctx.fc.testController?.manualRun(false, sub.make.test_suite.test, sub.make.ctx.fc.currentTestEnvironment);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editMakefileAm', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "eAm");
        let p = path.join(sub.make.ctx.fc.folder.uri.path,sub.make.dir,'Makefile.am');
        await openEditor(p);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.newConfiguration', async (sub: tree.Node | undefined) => {
        telemetry.logEvent(extension.journey, "nC");
        if (sub)
            openSettings("autotools.configurations", sub.make.ctx.fc.folder, false);
        else
            await configuration.selectFolderConfig().then(
                async fc => openSettings("autotools.configurations", fc.folder, false));

    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editConfigureAc', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "eAc");
        if (sub instanceof tree.SubNode) {
            let configureAc = sub.make.ctx.fc.configureAc;
            if (configureAc)
                await openEditor(path.join(sub.make.ctx.fc.folder.uri.path, configureAc));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.test', (goal: Goal) => {
        telemetry.logEvent(extension.journey, "t");
        if (!goal.task)
            throw new Error("Missing test task on TaskNode");
        if (goal.test && goal.make.ctx.fc.testController)
            return goal.make.ctx.fc.testController.manualRun(false, goal.test, goal.make.ctx.fc.currentTestEnvironment);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.debug', async (goal: Goal) => {
        if (!goal.task)
            throw new Error("Missing test task on TaskNode");
        let span = telemetry.startSpan("debugCmd", extension.journey);
        if (goal.test && goal.make.ctx.fc.testController)
            goal.make.ctx.fc.testController.debug(span, goal.test, goal.make.ctx.fc.currentTestEnvironment);
        else
            telemetry.setSpanStatus(span, SpanStatusCode.ERROR, "noTestOrController");
        span.end();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.openLog', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "oLo");
        return Promise.resolve(openLog(sub));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.closeIrrelevant', async (sub: vscode.Uri) => {
        let relevant = extension.suiteDecorator.getRelevantFiles();
        let numClosed : number = 0;
        vscode.window.tabGroups.all.forEach(g => {
            let irrelevant_tabs = g.tabs.filter(t =>
                t.input instanceof vscode.TabInputText && !relevant.has(t.input.uri.path) );
            numClosed += irrelevant_tabs.length;
            vscode.window.tabGroups.close(irrelevant_tabs);
        });
        telemetry.logEvent(extension.journey, "cIr", {nt: numClosed});
        return Promise.resolve();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildConfiguration', async (sub: tree.Node | undefined) => {
        telemetry.logEvent(extension.journey, "nC");
        if (sub)
            await configuration.setNewConfiguration(extension.journey, sub.make.ctx.fc);
        else
            await configuration.selectFolderConfig().then(
                async fc => await configuration.setNewConfiguration(extension.journey, fc));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setBuildConfiguration', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "sBC");

        if (!sub.make.ctx.fc.buildConfig.top_builddir && sub.make.ctx.fc.isConfigured) {
            const doit: string = localize("autotools.switch.to.out.of.tree", "Browse doc page");
            vscode.window.showErrorMessage(
                localize("autotools.want.out-of-tree", "The project does not support additional build configurations until it is switched to out-of-tree build mode."),
                doit,
                localize("autotools.cancel", "Cancel")).then((value) => {
                if (value === doit) {
                    // this.autotoolsTask.bootstrap();
                    vscode.commands.executeCommand('vscode.open', "https://autotools.mergesium.com/kb/docs/#switch-to-out-of-tree-configuration");
                }
            });
        } else {
            try {
                await configuration.setNewConfiguration(extension.journey, sub.make.ctx.fc);
            } catch (e) {
                logger.message(`ERROR: switching configuration failed: ${e}`, 'Normal');
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setTestEnvironment', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "sTE");
        await configuration.setNewEnvironment(sub.make.ctx.fc);
    }));

    logger.message(`${getStartTime(validact).toISOString()}: starting ${Extension.whoami} ${context.extension.packageJSON.version}/${buildinfo.platform}-${buildinfo.arch}`, 'Normal');
    extension.registerTasks();

    if (buildinfo.arch != process.arch || buildinfo.platform != process.platform) {
        vscode.commands.executeCommand('setContext', "autotools:binaryIncompatible", true);
        telemetry.endSpanWithStatus(act, SpanStatusCode.ERROR, "binIncompatible");
        return;
    }

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        let span = telemetry.startSpan("openWS", extension.journey);
        await configuration.onWorkspaceChange(e, span);
        span.end();
    }));

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (f) => {
        let fcs : Set<FolderConfig> = new Set;
        if (f.uri.scheme === "file" &&
            !ignoredSaveFiles.has(path.basename(f.uri.fsPath))) {
                let fc = configuration.findFolderConfig(f.uri);
                if (fc) fcs.add(fc);
            if (!vscode.workspace.textDocuments.some((d) => d.isDirty))
                fcs.forEach(async fc => await fc.testController?.onSavedAll());
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidCreateFiles(async (f) => {
        //        if (extension.testController && f.uri.scheme === "file" &&
        //            !ignoredSaveFiles.has(path.basename(f.uri.fsPath))) {
        //            if (!vscode.workspace.textDocuments.some((d) => d.isDirty))
        //                await extension.testController?.onSavedAll();
        //        }
                logger.message("created files", 'debug');
    }));

    // context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors( (editors) => {
    //     // logger.message(`Opened file ${.uri}`, "Normal");
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(async (tabs) => {
        let changed = [...tabs.opened,...tabs.closed];
        let notified : Set<FolderConfig> = new Set();
        tabs.opened.forEach(t => {
            if ((t.input instanceof vscode.TabInputText) &&  t.input.uri.scheme === "file") {
            let fc = configuration.findFolderConfig(t.input.uri);
            if (fc && !notified.has(fc)) {
                notified.add(fc);
                fc.testController?.onOpenedDocument();
            }
        }});
    }));

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(extension.suiteDecorator));

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TestGrid.scheme, extension.projectTestGrid));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === TestGrid.scheme) {
            extension.projectTestGrid.closeDocument(doc.uri);
        }
    }))

    await configuration.initFromSettings(true, act);

    if (configuration.cppProvider != Extension.whoami) {
        telemetry.setAttributes(act, {cppProvider: configuration.cppProvider});
    }

    util.scheduleAsyncTask<void>(async () => {
        await extension.registerCppTools();
        if (!extension.cppToolsAPI) {
            logger.message('C/C++ Intellisense is not loaded. Install an extension to enable syntax highlighting and completions.', "Normal");
        }

        configuration.loadAllFolders();
        await configuration.startAllFolders(validact);
        logger.message("=======================", "Normal");
        if (configuration.hasAnyAutotoolsFolders()) {
            extension.tasksBugWorkaround();
        }
        extension._activatedEvent.fire(true);
        validact.end();
    });

    } catch (e) {
        /* Can be caused by:
            extensionHost.js:
            Exception has occurred: Error: EEXIST: file already exists, open '/home/radu/.vscode-server/data/User/workspaceStorage/ad45d8b1a8e4f48738c477fbc86abc47/vscode.lock'

            Exception has occurred: Error: kill ESRCH
            t process.kill (node:internal/process/per_thread:220:13)
            at w (/home/radu/.vscode-server/bin/704ed70d4fd1c6bd6342c436f1ede30d1cff4710/out/vs/workbench/api/node/extensionHostProcess.js:106:4069)
            at h (/home/radu/.vscode-server/bin/704ed70d4fd1c6bd6342c436f1ede30d1cff4710/out/vs/workbench/api/node/extensionHostProcess.js:106:3576)
	at async O.g (/home/radu/.vscode-server/bin/704ed70d4fd1c6bd6342c436f1ede30d1cff4710/out/vs/workbench/api/node/extensionHostProcess.js:106:1824)
	at async O.h (/home/radu/.vscode-server/bin/704ed70d4fd1c6bd6342c436f1ede30d1cff4710/out/vs/workbench/api/node/extensionHostProcess.js:101:131918)

        */

        logger.message(`ERROR: Unexpected activation exception: ${e}`, "Normal");
        if (act) telemetry.endSpanWithStatus(act, SpanStatusCode.ERROR, e.toString());

    }
}

export async function deactivate(): Promise<void> {
    // vscode.window.showInformationMessage(localize("extension.deactivated", "The extension {0} is de-activated.", "''"));

    extension.journey.end();
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

async function focusPreviewedDocument(uri: vscode.Uri) : Promise<void> {
    let summary = vscode.Uri.from({scheme: TestGrid.scheme, path: uri.path});
    let existingEditor : vscode.TextEditor | undefined =
        vscode.window. visibleTextEditors.find(e =>
                e.document.uri.path == summary.path);
    let opened = vscode.workspace.textDocuments.find(d => d.uri.path == summary.path);
    if (!existingEditor) {
        await vscode.window.showTextDocument(summary, GridShowOptions).then((editor) => {
            if (!opened) {
                vscode.languages.setTextDocumentLanguage(editor.document, "markdown");
            }
        });
        if (!opened) await vscode.commands.executeCommand("markdown.showPreview", summary);
    }
}

function instanceOfTestItem(object: any): object is TestItem {
    return 'id' in object;
}
