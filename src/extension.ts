// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Makefile Tools extension

import * as configuration from './configuration';
import { MakefileConfiguration, TestEnvironment } from './configuration';
import * as cpptools from './cpptools';
import * as logger from './logger';
import * as util from './util';
import * as make from './make';
import { TRS } from './make';
import * as toolParser from './parser/tool';
import * as gnumake from './parser/gnumake';
import { Goal } from './parser/gnumake';
import * as path from 'path';
import * as state from './state';
import { SpanStatusCode, getStartTime } from './tele';
import {
    ProjectOutlineProvider,
    ProjectTestsProvider,
    } from './tree';
import * as tree from './tree';
import * as ui from './ui';
import { resolvePathToRoot,
         checkFileExistsSync } from './util';
import * as vscode from 'vscode';
import { TestItem } from 'vscode';
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
import { TestGrid, GridShowOptions } from './testgrid';
import * as tele from './tele';
import * as nls from 'vscode-nls';
import { assert, log } from 'console';
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

    public readonly journey;
    private mementoState : state.StateManager;
    public readonly _projectOutlineProvider;
    public readonly _projectTestSuitesProvider;
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
    private checkTasks: AutoToolsCheckTaskProvider;
    private needTaskFetchBugWorkaround: boolean = true;
    private compilerFullPath ?: string;
    public readonly dryRunner : string;
    public readonly testRunner : string;
    public readonly rulesPath : string;
    public readonly userEnvName : string = "<none>";
    public testController : MyTestController | undefined;
    public pkginfo : make.pkgInfo | undefined;
    private _treeDisposables: vscode.Disposable[] = [];
    public running: WeakMap<vscode.TaskExecution, Span> = new WeakMap();

    public constructor(public readonly extensionContext: vscode.ExtensionContext, teleParams: tele.Params) {
        telemetry = new tele.MyTelemetry(extensionContext, teleParams);
        this.journey = telemetry.startSpan('j');

        this.mementoState = new state.StateManager(this.extensionContext);
        this._projectOutlineProvider = new ProjectOutlineProvider(this.journey, this.mementoState.buildConfiguration);
        this._projectTestSuitesProvider = new ProjectTestsProvider(this.journey);

        this.autotoolsTask = new AutoToolsBootstrapTaskProvider();
        this.buildTasks = new AutoToolsBuildTaskProvider();
        this.testTasks = new AutoToolsTestTaskProvider();
        this.checkTasks = new AutoToolsCheckTaskProvider();
        this.tasks = [
            this.autotoolsTask,
            this.buildTasks,
            this.testTasks,
            this.checkTasks,
        ];
        this.dryRunner = path.join(extensionContext.extensionPath, "bin/make" + (process.platform === 'win32' ? ".exe" : ""));
        this.testRunner = path.join(extensionContext.extensionPath, "bin/test-driver");
        this.rulesPath = path.join(extensionContext.extensionPath, "include")

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.bootstrap', async () => {
            telemetry.logEvent(this.journey, "cBs");
            let te = await this.autotoolsTask.bootstrap();
            te && this.running.set(te, extension.journey);
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.regen', async () => {
            telemetry.logEvent(this.journey, "cRegen");
            await this.autotoolsTask.regen();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.configure.help', async () => {
            telemetry.logEvent(this.journey, "cHelp");
            await this.autotoolsTask.help();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.knowledgeBase', async () => {
            telemetry.logEvent(this.journey, "gKB");
            await this.gotoKnowledgeBase();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.packageURL', async () => {
            telemetry.logEvent(this.journey, "gpU");
            if (this.pkginfo?.url)
                vscode.commands.executeCommand('vscode.open', this.pkginfo.url);
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.gotoBuildDirectory', async (goal: Goal) => {
            telemetry.logEvent(this.journey, "gBD");
            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.from({
                scheme: 'file',
                path: util.resolvePathToRoot(configuration.getCurrentMakefileConfiguration().top_builddir)
            }));
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.visit.packageBugs', async () => {
            telemetry.logEvent(this.journey, "gpBugs");
            if (this.pkginfo?.bugreport)
                vscode.commands.executeCommand('vscode.open', this.pkginfo.bugreport);
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.openKnowledgeBase', async () => {
            await this.gotoKnowledgeBase();
        }));
        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.testgrid.top', async (e) => {
            telemetry.logEvent(this.journey, "topgrid");
            let summary : vscode.Uri = vscode.Uri.from({
                scheme: TestGrid.scheme,
                authority: "mergesium.autotools",
                path: TestGrid.top,
            });
            await focusPreviewedDocument(summary);
        }));

        extensionContext.subscriptions.push(vscode.commands.registerCommand('autotools.command.testgrid.item', async (sub: tree.SubNode | TestItem) => {
            telemetry.logEvent(this.journey, "itemgrid");
            let dir : string | undefined;
            if (sub instanceof tree.SubNode && sub.make.test_suite) {
                dir = sub.make.dir;
            } else if (instanceOfTestItem(sub)) {
                dir = sub.parent?.id ?? sub.id;
            }
            if (dir) {
                let summary : vscode.Uri = vscode.Uri.from({
                    scheme: TestGrid.scheme,
                    authority: "mergesium.autotools",
                    path: '/' + dir,
                });
                await focusPreviewedDocument(summary);
            }
    }));

        debugProvider.activate(extensionContext);
    }
    public getProjectName() : string {
        if (this.pkginfo) {
            if (this.pkginfo.version)
                return `${this.pkginfo.name} ${this.pkginfo.version}`;
            else
                return `${this.pkginfo.name}`;
        }
        return configuration.getFolder();
    }
    // Force read pkginfo even if already set, used when configure.ac changes
    public async readPkgInfo() : Promise<void> {
        this.pkginfo = await make.getPackageJSON().catch<undefined>(() =>
            Promise.resolve(undefined));
        vscode.commands.executeCommand("setContext", "autotools:packageHasURL",
            this.pkginfo?.url ? 1 : 2);
        vscode.commands.executeCommand("setContext", "autotools:packageHasIssues",
            this.pkginfo?.bugreport ? 1 : 2);
    }
    public kbUrlStatic : vscode.Uri = vscode.Uri.from({
        scheme: 'https',
        authority: 'autotools.mergesium.com',
        path: `/kb/${configuration.getFolder()}`});

    public async kbUrl() : Promise<vscode.Uri> {
        if (!this.pkginfo)
            await this.readPkgInfo();

        if (!this.pkginfo)
            return Promise.resolve(this.kbUrlStatic);

        this.kbUrlStatic = vscode.Uri.from({
            scheme: 'https',
            authority: 'autotools.mergesium.com',
            path: '/kb/' + util.slugify(this.pkginfo?.name ?? 'unknown'),
            // The s- prefix matches my_kramdown_patch
            // Used for headings that start with digits (1.0.0) because html element ids cannot begin with non letter
            query: this.pkginfo?.version.match(/^a-zA-Z/) ?
                'v=' + util.slugify('s-' + this.pkginfo?.version) :
                this.pkginfo?.version ? 'v=' + util.slugify(this.pkginfo?.version) : undefined
        });
        return Promise.resolve(this.kbUrlStatic);
    }
    async gotoKnowledgeBase() {
        let kburl = await this.kbUrl();
        vscode.commands.executeCommand('vscode.open', kburl.toString(true));
    }
    public createPanel() : void {
        this._projectOutlineTreeView = vscode.window.createTreeView('autotools.outline', {
            treeDataProvider: this._projectOutlineProvider,
            canSelectMany: true,
            showCollapseAll: false

        });

        this._projectOutlineTreeView.onDidChangeSelection(e => {
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
        });
        this._projectTestSuitesView = vscode.window.createTreeView('autotools.tests', {
            treeDataProvider: this._projectTestSuitesProvider,
            canSelectMany: true,
            showCollapseAll: false

        });
        this._treeDisposables.push(vscode.commands.registerCommand('autotools.rdepends', async (sub: vscode.Uri) => {
            if (!(sub instanceof vscode.Uri))
                return Promise.reject("Expected file Uri argument");
            configuration.setCurrentGoalBins(undefined);
            configuration.setCurrentGoalTests(undefined);
            // vscode.commands.executeCommand('workbench.action.openView', this._projectTestSuitesView);
            vscode.commands.executeCommand('autotools.tests.focus');
            let goals = extension._projectOutlineProvider.selectRdepends(sub.path);
            for (const g of goals) {
                if (g.flags & Goal.Flags.Test_Log) {
                    extension._projectTestSuitesProvider.all.set(g.getFilePath(), g); // Fixme - this cn be moved to Test Tree build parents, it seems out of place here. Here it does lazy allocation, in buildParents it would be eager allocation
                    await this._projectTestSuitesView?.reveal(g, rdepRevealOption) // rdepRevealOption)
                    .then(() => {
                        console.debug('selected', g);
                    },
                    err => {
                        logger.message(`ERROR: Internal error finding goal ${g.goal} in tests tree`,'Normal');
                        telemetry.logException(new Error(`No ${g.goal} in test tree`), extension.journey);
                    })
                } else {
                    extension._projectOutlineProvider.all.set(g.getFilePath(), g); // Fixme - this cn be moved to Test Tree build parents, it seems out of place here. Here it does lazy allocation, in buildParents it would be eager allocation
                    await this._projectOutlineTreeView?.reveal(g, rdepRevealOption)
                    .then(() => {
                        console.debug('selected', g);
                    },
                    err => {
                        logger.message(`ERROR: Internal error finding goal ${g.goal} in programs tree`,'Normal');
                        telemetry.logException(new Error(`No ${g.goal} in bin tree`), extension.journey);
                    });
                }
            }
            this.suiteDecorator.highlightTargets(goals, sub.path);
            telemetry.logEvent(this.journey, "rdep", {num: goals.length});
            return Promise.resolve();
        }));

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
    public setTestEnvironmentName(name: string) {
        if (this._projectTestSuitesView) {
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

        if (oldresult == make.TRS.FAIL || oldresult == make.TRS.XPASS)
            this.testTasks.numFails--;
        else if (result == make.TRS.FAIL || result == make.TRS.XPASS)
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

        /* The test driver moves the trs to trs.tmp when generating a new one. Avoid test status updating to 'NONE'
         * while tests are running.
         */
        if (this.testController?.busyNonLiveTest)
            return;
        /* This is only used when the FS changes without a testRun in progress */
        let dir = path.relative(util.resolvePathToRoot(c.top_builddir), path.dirname(uri.path));
        let log = path.basename(uri.path, ".trs") + ".log";
        let goal = configuration.getAllBuildTargets()
            ?.get(dir)
            ?.get('test-suite.log')
            ?.depends?.find((d) => d.goal === log);

        if (goal) {
            let old = goal.trs;
            let newTRS = make.readTRS(new make.BuildTarget(dir, log), c);
            if (newTRS.results.size)
                goal.trs = newTRS;
            else
              return; // TRS file moved to .tmp
            this.updateTRSInPanel(env, old, goal, dir);
            let old_global = goal.trs?.global ?? TRS.NONE;
            if ( ((goal.test && goal.trs.global != old_global) || this.testController?.busy) && !(goal.flags & Goal.Flags.Test_Suite))
                /* If there is an active test run, use it to log the TRS result.
                 * Otherwise, create a new manual run
                 */
                if (!this.testController?.markActiveTestTRS(goal, dir))
                    goal.test && this.testController?.trsChange(goal.test, dir);
        }
    }
    private unsupported_log_count : number = 0;
    public updateTRSInPanel(env: TestEnvironment, old: make.TestResult | undefined, goal: Goal, dir: string) : void {
        /* The ?? defaults are needed when the test is not using my LOG_DRIVER
         * .. the TRS in the file will not have the hashCode
         *
         */
        let current : TRS | undefined = goal.trs!.results.get(env.hashCode);
        let oldTRS = old?.results.get(env.hashCode) ?? TRS.NONE;
        if (current === undefined && old !== undefined) {
            if (this.unsupported_log_count++ < 4) {
                logger.message(`ERORR: The test ${dir}/${goal.goal} did not use the ${Extension.whoami} LOG_DRIVER. Per-environment results not available.`);
                telemetry.setSpanStatus(this.journey, SpanStatusCode.ERROR, "unknown ?_LOG_DRIVER");
            }
        } else
        if ((current ?? TRS.NONE) != oldTRS) {
            (old != undefined) && this.suiteDecorator.update(goal.getURI());//  vscode.Uri.from(
//                {authority: Extension.whoami, scheme: 'test', path: '/' + dir, query: goal.goal}));
            //this.suiteDecorator.update(vscode.Uri.from(
            //    {authority: Extension.whoami, scheme: 'check', path: '/' + dir, query: 'test-suite.log'}));
            if (old !== undefined) // Don't update when TRS's are initially read from disk
                this.failStatUpdate(oldTRS, current ?? TRS.NONE);
            // Don't update the test suites. They are auto summarized
            this.updateOutlineBadge();
        }
    }

    public async bootstrapWithPrompt(span: Span) : Promise<void>  {
        if (!this.autotoolsTask.isBootstrapped()) {
            let cmd = this.autotoolsTask.bootstrap_cmd();
            if (cmd) {
                const doit: string = localize("autotools.bootstrap.me", "Bootstrap");
                const setit: string = localize("autotools.edit.setting", "Setting...");
                await vscode.window.showWarningMessage(
                    localize("autotools.want.bootstrap", "The project needs to be bootstrapped ('{0}').", cmd.join(' ')),
                    doit,
                    localize("autotools.cancel", "Cancel"), setit).then(async (value) => {
                    if (value === doit) {
                        let te = await this.autotoolsTask.bootstrap();
                        te && this.running.set(te, span);
                    } else if (value === setit) {
                        openSettings("autotools.autoBootstrap");
                    }
                });
            }
        }
    }

    public registerTasks(): void {
        // FIXME: Implement Disposable
        this.tasks.forEach((provider) => vscode.tasks.registerTaskProvider(provider.myType, provider));
        // It's possible that the fileWatcher takes too many descriptors, so
        // it might be replaced with waiting for exit codes.
        // Monitoring exit codes is blind to the user manually doing "make clean" or "make check"
        this.extensionContext.subscriptions.push(vscode.tasks.onDidEndTask((e) =>{
            let task = e.execution.task;
            let span = this.running.get(e.execution);
            if (task) {
                const definition: TestTask = <any>task.definition;
                if (definition.type == "test" && definition.test) {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.test.builddir)
                        ?.get('test-suite.log');
                    if (suite) {
                        let goal = suite.depends?.find((d) => d.goal === definition.test?.goal);
                        if (goal) {
                            definition.test && goal.test && this.testController!.testCompleted(e.execution, goal, definition.test);
                        }
                    }
                    this.autotoolsDoneNoResult();
                    extension.updateAllGrids();
                } else if (definition.type == 'check') {
                    let suite = configuration.getAllBuildTargets()
                        ?.get(definition.builddir)
                        ?.get('test-suite.log');
                    if (suite && suite.test) {
                        this.testController?.suiteCompleted(e.execution, suite, definition.builddir);
                    }
                    this.autotoolsDoneNoResult();
                    extension.updateAllGrids();
                } else if (definition.type == "autotools") {
                    this.autotoolsDoneNoResult();
                }
            }
            span?.end();

        }));
        this.extensionContext.subscriptions.push(vscode.tasks.onDidEndTaskProcess(async (e) => {
            let task = e.execution.task;
            if (task) {
                let tspan = this.running.get(e.execution);
                let span = tspan ?? extension.journey;
                const definition: TestTask = <any>task.definition;
                if (definition.type == "test" && definition.test) {
                } else if (definition.type == 'check') {
                } else if (definition.type == "autotools") {
                    const definition: AutotoolsTask = <any>task.definition;
                    ui.getUI().setStatus(e.exitCode ? ui.UIStatus.ERR : ui.UIStatus.OK);
                    //if (definition?.action == "regen" || definition?.action == "recheck")
                    await this.autotoolsTask.autotoolsDone(task.execution,
                            (typeof e.exitCode == 'number') ? e.exitCode : (e.exitCode ? 1 : 0));
                    if (!e.exitCode) {
                        if (definition?.action == "bootstrap") {
                            await configuration.analyzeConfigureParams(span, false, false);
                        } else if (definition?.action == "regen" || definition?.action == "recheck" || definition?.action == "configure") {
                            let r = await configuration.analyzeConfigureParams(span, false, true) &&
                                !await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange);
                            if (r)
                                if (this.testController) {
                                    this.testController.onSavedAll();
                                };
                        }
                        tspan && telemetry.setSpanStatus(tspan, SpanStatusCode.OK);
                    } else {
                        ui.getUI().setLoading(ui.UIStatus.ERR);
                        tspan && telemetry.setSpanStatus(tspan, SpanStatusCode.ERROR, `status ${e.exitCode}`);
                    }
                }
            }
        }));
        this.extensionContext.subscriptions.push(vscode.debug.onDidStartDebugSession(e => {
            let type = e.configuration.testUri ?
                (e.configuration.testUri.scheme == "test" ? "debugT" : "debugR") : "debug";
            extension.testController?.debugStarted(e, type);
        }));
        this.extensionContext.subscriptions.push(vscode.debug.onDidTerminateDebugSession(e => {
            // if (e.configuration.testUri) {
                extension.testController?.debugEnded(e);
            //}
        }));
    }
    tasksBugWorkaround() : void {
        if (this.needTaskFetchBugWorkaround && this.isAutotoolsProject()) {
            // FIXME: This is a workaround for vscode not parsing tasks.json prior to fetchTasks()
            const kind:BuildTask = {
                type: "build",
                target: new make.BuildTarget(".", "fetchTasks-bug-workaround")
            };
            let workaroundTask = new vscode.Task(kind, vscode.TaskScope.Workspace, 'autotools', 'autotools',
            new vscode.ProcessExecution("true", ["this-is-a-workaround-for-fetchTasks-bug-not-parsing-tasks-json"]));
            workaroundTask.presentationOptions = {
                reveal: vscode.TaskRevealKind.Always,
                panel: vscode.TaskPanelKind.Shared,
                showReuseMessage: false};
            workaroundTask.isBackground = true;
            vscode.tasks.executeTask(workaroundTask);
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

    public readonly projectTestGrid = new TestGrid();
    public updateAllGrids() : void {
        this.projectTestGrid.updateAll();
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
        if (!build_tree.hasStats) {
            countStats(build_tree);
            build_tree.hasStats = true;

            vscode.commands.executeCommand('setContext', "autotools:haveParallelHarness", build_tree.stats.checks ? 1 : 2);
        }
        if (build_tree.stats.checks) {
            if (!this.testController) {
                this.testController = new MyTestController(
                    Extension.whoami, "Autotools tests", extension.getState().liveCheckId);
            } else {
                this.testController?.deactivate();
                this.testController?.restart();
            }
        } else {
            this.testController?.deactivate();
            this.testController = undefined;
        }
        this.tasks.forEach((provider) => provider.update(this.configDisposables));
        if (this._projectOutlineTreeView) {
            this._projectOutlineProvider.updateTargets(build_tree);
        }
        if (this._projectTestSuitesView) {
            this._projectTestSuitesProvider.updateTargets(build_tree);
            this.updateOutlineBadge();
        }
        vscode.commands.executeCommand("setContext", "autotools:hasTargets", 1);
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
            this.journey.addEvent("deb");
            let c = configuration.getCurrentMakefileConfiguration();
            let dopt : vscode.DebugSessionOptions = {
                compact: true
            };
            try {
                vscode.debug.startDebugging(
                    vscode.workspace.workspaceFolders?.[0],
                    new DebugNow(c, goal, {goal: goal.depends[0].goal, builddir: builddir},
                            !!(goal.depends[0].flags & Goal.Flags.Linked_binary), env),
                    dopt)
                .then((z) => console.log(z));
            } catch(e) {
                logger.message(`ERROR: Failed to start debugging: ${e}`);
            }
        } else
            this.journey.addEvent("debNoS");
    }

    public onConfigurationSelect(c: configuration.MakefileConfiguration) : void {
        this.tasks.forEach((provider) => provider.changeConfiguration(c, this.configDisposables));
        this.configDisposables.forEach((d) => d.dispose());
        this.configDisposables = [];
    }
    public bootstrap(span: Span): void {
        this.autotoolsTask.bootstrap();
    }
    // config.status (just re-output)
    public async regen(): Promise<void> { await this.autotoolsTask.regen(); }
    // config.status --recheck
    public async recheck(changed: boolean): Promise<void> {
        if (changed) {
            if (!this.isBootstrapped()) {
                await this.bootstrapWithPrompt(extension.journey);
                return Promise.resolve();
            } else if (this.isAutotoolsProject()) {
                let span = telemetry.startSpan("recheck", extension.journey);
                // newly installed
                statusBar.show();
                configuration.initFromState();
                await configuration.initFromSettings(true, span);
                await configuration.analyzeConfigureParams(span, false, false);
                await outputLogHeader();
                await extension.configure(span);
                span.end();
                return Promise.resolve();
            } else if (this.isAutotoolsProject() && !this.autotoolsTask.bootstrap_cmd()) {
                // Disable extension, configure.ac deleted
                return Promise.resolve();
            }
        }
        await this.autotoolsTask.recheck();
        if (changed && vscode.workspace.textDocuments.find((d) => d.isDirty))
            this.testController?.onSavedAll();
        return Promise.resolve();
    }
    public autotoolsDoneNoResult(): void { this.autotoolsTask.autotoolsDoneNoResult(); }
    public async waitToTouchMakefiles(): Promise<void> { await this.autotoolsTask.waitToTouchMakefiles(); }

    public build(target: make.BuildTarget): void { this.buildTasks.build(target); }
    public async checkAll(): Promise<void> { await this.checkTasks.checkAll(); }
    public async configure(span: Span): Promise<boolean> {
        this.needTaskFetchBugWorkaround = false;
        var success =  await this.autotoolsTask.configure(span);
        if (!success) {
            let kbUrl = await extension.kbUrl();
            logger.message('Configure failed. Review the Terminal tab for cause.', "Normal");
            logger.message('Configuring can be re-attempted with "Autotools: Configure"', "Normal");
            logger.message('KB: ' + kbUrl.toString(true) + '#config-fail', "Normal");
        }
        this.updateMakefileFilePresent(success);
        return success;
    };
    public isAutotoolsProject(): boolean { return !!configuration.getConfigureAc(); }
    public isBootstrapped(): boolean { return this.autotoolsTask.isBootstrapped(); }
    public isConfigured(): boolean { return this.autotoolsTask.isConfigured(configuration.getCurrentMakefileConfiguration()); }

    public updateMakefileFilePresent(newValue: boolean): void {
        vscode.commands.executeCommand("setContext", "autotools:makefileFilePresent", newValue ? 1 : 2);
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

/* returns whether configuration was done or not (bool) */
let isActive: boolean = false;
let _activatedEvent: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
export async function waitActivated() : Promise<boolean> {
    if (isActive)
        return Promise.resolve(isActive);
    return new Promise<boolean>(resolve => {
        let a = _activatedEvent.event(e => {
            a.dispose();
            return resolve(e);
        });
    });
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    let act : Span | undefined = undefined;
    try {
    let teleParams = await tele.getParams();
    extension = new Extension(context, teleParams);
    let validact = telemetry.startSpan('act', extension.journey);
    act = validact;

    context.subscriptions.push(vscode.commands.registerCommand('autotools.setBuildConfiguration', async () => {
        telemetry.logEvent(extension.journey, "sBC");
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
            await configuration.setNewConfiguration(extension.journey);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.getConfiguration', async () => {
        telemetry.logEvent(extension.journey, "aGC");
        return configuration.getCurrentMakefileConfiguration();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.goal', async () => {
        telemetry.logEvent(extension.journey, "agoal");
        return (await configuration.getCurrentTarget()).goal;
    }));

    /* also need top_builddir */
    context.subscriptions.push(vscode.commands.registerCommand('autotools.builddir', async () => {
        telemetry.logEvent(extension.journey, "abd");
        return (await configuration.getCurrentTarget()).builddir;
    }));

    // Return the relative path to the default build task's target
    // or the first Linked_binary target detected.
    // Due to bug in cpptools, this temporarily returns an absolute path (always), but
    // this will eventually be fixed. Don't rely on abs paths.
    context.subscriptions.push(vscode.commands.registerCommand('autotools.default_program', async () => {
        telemetry.logEvent(extension.journey, "adp");
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
        telemetry.logEvent(extension.journey, "dpbt");
        let built = await configuration.getCurrentTarget();
        return 'autotools: build \'' + built.goal + '\' in ' + built.builddir;
    }));
    /** End of commands that shouldn't be exposed in package.json, they are used for command substitution in launch.json and tasks.json. */

    context.subscriptions.push(vscode.commands.registerCommand('autotools.addAutotools', async () => {
        telemetry.logEvent(extension.journey, "aa");
        await installAutotools();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "obA");
        if (sub instanceof tree.SubNode)
            extension.build(new make.BuildTarget(sub.make.dir, make.t_all.goal));
        else
            extension.build(make.t_all);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.buildAll', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "ba");
        if (sub instanceof tree.SubNode)
            extension.build(new make.BuildTarget(sub.make.dir, make.t_all.goal));
        else
            extension.build(make.t_all);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.checkAll', async () => {
        telemetry.logEvent(extension.journey, "ocA");
        await extension.checkAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.checkAll', async () => {
        telemetry.logEvent(extension.journey, "ckA");
        await extension.checkAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.exportToIntelisense', async () => {
        telemetry.logEvent(extension.journey, "exp");
        await make.configure(extension.journey, make.TriggeredBy.configure);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.recheck', () => {
        telemetry.logEvent(extension.journey, "orc");
        extension.recheck(false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.configure', async () => {
        telemetry.logEvent(extension.journey, "c");
        await extension.configure(extension.journey);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.build', async (goal: Goal) => {
        telemetry.logEvent(extension.journey, "b");
        if (!goal.task)
            throw new Error("Missing build task on TaskNode");
        if (goal.task instanceof vscode.Task)
            return await vscode.tasks.executeTask(goal.task);
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
            extension.testController?.togglelivecheck(sub.getTreeItem(),sub.make.test_suite.test);
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
            extension.testController?.run(sub.make.test_suite.test, configuration.getCurrentTestEnvironment());
            // return await vscode.tasks.executeTask(sub.submake.test_suite.test);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editMakefileAm', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "eAm");
        await openEditor(sub.makefile());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.newConfiguration', async (sub: tree.Node | undefined) => {
        telemetry.logEvent(extension.journey, "nC");
        openSettings("autotools.configurations");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.editConfigureAc', async (sub: tree.SubNode) => {
        telemetry.logEvent(extension.journey, "eAc");
        let configureAc = configuration.getConfigureAc();
        if (configureAc)
            await openEditor(configureAc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.test', (goal: Goal) => {
        telemetry.logEvent(extension.journey, "t");
        if (!goal.task)
            throw new Error("Missing test task on TaskNode");
        if (goal.test && extension.testController)
            return extension.testController.run(goal.test, configuration.getCurrentTestEnvironment());
        //return await vscode.tasks.executeTask(sub.goal.task);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.debug', async (goal: Goal) => {
        telemetry.logEvent(extension.journey, "d");
        if (!goal.task)
            throw new Error("Missing test task on TaskNode");
        if (goal.test && extension.testController)
            extension.testController.debug(goal.test, configuration.getCurrentTestEnvironment());

//        const definition: TestTask = <any>sub.goal.task.get.definition;
//            if (definition?.type == 'test' && sub.goal && definition.test)
//                extension.debugGoal(sub.goal, definition.test.builddir, configuration.getProjectTestEnvironment());
//        }
        // return await vscode.tasks.executeTask(sub.goal.task);
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

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setBuildConfiguration', () => {
        telemetry.logEvent(extension.journey, "sBCo");
        return vscode.commands.executeCommand("autotools.setBuildConfiguration");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotools.outline.setTestEnvironment', () => {
        telemetry.logEvent(extension.journey, "sTE");
        return configuration.setNewEnvironment();
    }));

    logger.message(`${getStartTime(validact).toISOString()}: starting ${Extension.whoami} ${context.extension.packageJSON.version}`, 'Normal');
    extension.registerTasks();

    if (buildinfo.arch != process.arch || buildinfo.platform != process.platform) {
        vscode.commands.executeCommand('setContext', "autotools:binaryIncompatible", true);
        telemetry.endSpanWithStatus(act, SpanStatusCode.ERROR, "binIncompatible");
        return;
    }
    detectWorkspaceMode();
    if (vscode.workspace.workspaceFolders == undefined) {
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
            detectWorkspaceMode();
            if(vscode.workspace.workspaceFolders?.length == 1) {
                let span = telemetry.startSpan("openWS", extension.journey);
                await startupWithWorkspace(context, span, span);
                // span.end();
            }
        }));
        telemetry.endSpanWithStatus(act, SpanStatusCode.OK, "noWS");
        return;
    } else if (vscode.workspace.workspaceFolders.length != 1) {
        telemetry.endSpanWithStatus(act, SpanStatusCode.OK, "multiRoot", {n: vscode.workspace.workspaceFolders.length});
        //telemetry.logEvent(act, "multiRoot", {n: vscode.workspace.workspaceFolders.length});
        //act.end();
    } else
        await startupWithWorkspace(context, validact, act);
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

function detectWorkspaceMode() {
    vscode.commands.executeCommand('setContext', "autotools:workspace",
        (vscode.workspace.workspaceFolders == undefined) ? 2 :
        (vscode.workspace.workspaceFolders.length == 1) ? 1 :
        3);
}
export async function startupWithWorkspace(context: vscode.ExtensionContext, validact: Span, act: Span) : Promise<void> {
    let configureAc = AutoToolsBootstrapTaskProvider.manifests.find((m) => checkFileExistsSync(resolvePathToRoot(m)));
    configuration.setConfigureAc(configureAc);

    // Read from the workspace state before reading from settings,
    // becase the latter may use state info in variable expansion.
    if (extension.isAutotoolsProject()) {
        statusBar.show();
        configuration.initFromState();
        await configuration.initFromSettings(true, act);

        await configuration.analyzeConfigureParams(act, false, false);

        await outputLogHeader();
        await extension.bootstrapWithPrompt(act);
    }

    extension.tasksBugWorkaround();

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (f) => {
        if (extension.testController && f.uri.scheme === "file" &&
            !ignoredSaveFiles.has(path.basename(f.uri.fsPath))) {
            if (!vscode.workspace.textDocuments.some((d) => d.isDirty))
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

    if (vscode.workspace.workspaceFolders) {
        let configureAc = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], (configuration.getConfigureAc() || "configure.ac")));
        context.subscriptions.push(configureAc.onDidChange(async (e) => await extension.recheck(true)));
        context.subscriptions.push(configureAc.onDidCreate(async (e) => await extension.recheck(true)));
        context.subscriptions.push(configureAc.onDidDelete(async (e) => await extension.recheck(true)));
    }

    context.subscriptions.push(vscode.window.registerFileDecorationProvider(extension.suiteDecorator));

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TestGrid.scheme, extension.projectTestGrid));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === TestGrid.scheme) {
            extension.projectTestGrid.closeDocument(doc.uri);
        }
    }))

    if (!configuration.getConfigurationMakefile()) {
        ui.getUI().setLoading(extension.isAutotoolsProject() ? ui.UIStatus.ERR : ui.UIStatus.NON_AUTOTOOLS);
        act.end();
        isActive = true;
        _activatedEvent.fire(isActive);
        return;
    }
    if (!configuration.initialConfigurationAttempted)
        util.scheduleAsyncTask<void>(async () => {
            await make.configure(validact, make.TriggeredBy.cleanConfigure);
            validact.end();
            isActive = true;
            _activatedEvent.fire(isActive);
            });
    else {
        act.end();
        isActive = true;
        _activatedEvent.fire(isActive);
    }
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

async function focusPreviewedDocument(uri: vscode.Uri) : Promise<void> {
    let summary = vscode.Uri.from({scheme: TestGrid.scheme, path: uri.path});
    let existingEditor : vscode.TextEditor | undefined =
        vscode.window. visibleTextEditors.find(e =>
                e.document.uri.path == summary.path);
    let opened = vscode.workspace.textDocuments.find(d => d.uri.path == summary.path);
    if (!existingEditor) {
        await vscode.window.showTextDocument(summary, GridShowOptions).then((editor) => {
            if (!opened)
                vscode.languages.setTextDocumentLanguage(editor.document, "markdown");
        });
        if (!opened) await vscode.commands.executeCommand("markdown.showPreview", summary);
    }
}

function instanceOfTestItem(object: any): object is TestItem {
    return 'id' in object;
}
