// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Configuration support

import { extension, telemetry, statusBar } from './extension';
import { SpanStatusCode } from './tele';
import * as logger from './logger';
import * as make from './make';
import { TRS } from './make';
import { MakeContext, Make, Goal, countStats } from './parser/gnumake';
import * as toolParser from './parser/tool';
import * as ui from './ui';
import * as util from './util';
import { loggingLevelApplies } from './logger';
import * as vscode from 'vscode';
import { WorkspaceFolder } from 'vscode';
import * as path from 'path';
import { Extension, openSettings } from './extension';
import { createHash } from 'crypto';
import * as cpp from 'vscode-cpptools';
import * as cpptools from './cpptools';
import { MyTestController } from './test';

import * as nls from 'vscode-nls';
import { AutoToolsBuildTaskProvider,
    AutoToolsTestTaskProvider,
    AutoToolsCheckTaskProvider,
    AutoToolsBootstrapTaskProvider,
    AutotoolsTask,
    BuildTask,
    TestTask,
    MyTaskProvider } from './tasks';
import { assert } from 'console';
import { quote } from '@mergesium/shell-quote';
import { Span } from '@opentelemetry/api';
import { Disposable } from 'vscode-jsonrpc';
import { CppConfigurationProvider } from './cpptools';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

// let statusBar: ui.UI = ui.getUI();

// Each different scenario of building the same makefile, in the same environment, represents a configuration.
// Example: "make BUILD_TYPE=Debug" and "make BUILD_TYPE=Release" can be the debug and release configurations.
// The user can save several different such configurations in autotools.configurations setting,
// from which one can be picked via this extension and saved in settings.

// Priority rules for where is the Makefile Tools extension parsing the needed information from:
//    1. autotools.configurations.makeArgs
//    2. autotools.makePath and default args
//    3. default make tool and args

export interface MakefileConfiguration {
    // A name associated with a particular build command process and args/options
    name: string;

    // a folder path (full or relative) containing the entrypoint makefile
    top_builddir: string;

    // options used in the build invocation
    // don't use more than one argument in a string
    makeArgs?: string[];

    // configure arguments
    configureArgs?: string[];

    // list of problem matcher names to be used when building the current target
    problemMatchers?: string[];

    // is this a default configuration?
    isDefault: boolean;

    // unwriteable file used to block autmake TEST_SUITE outputting summaries for indiv. tests
    // One environment set for each TestEnvironment, indexed by name
    //nologs: Map<string,vscode.ProcessExecutionOptions>;

    // TODO: investigate how flexible this is to integrate with other build systems than the MAKE family
    // (basically anything that can produce a dry-run output is sufficient)
    // Implement set-able dry-run, verbose, change-directory and always-make switches
    // since different tools may use different arguments for the same behavior
}

export interface TestEnvironment {
    // A name associated with this environment
    name: string;

    // Directories where applicable
    dirs?: string[];

    // A set of environment variables
    TESTS_ENVIRONMENT?: EnvironmentSetting;

    // Hash of the TESTS_ENVIRONMENT var as included in testExecOptions
    // This includes the global TESTS_ENVIRONMENT
    hashCode: number;

    // List of tests expected to fail
    XFAIL_TESTS?: string[];

    // Testing UI run profile
    run?: vscode.TestRunProfile;

    // Testing UI debug profile
    debug?: vscode.TestRunProfile;

    // Environemnts for single tests and for check suites
    testExecOptions?: vscode.ProcessExecutionOptions;
    checkExecOptions?: vscode.ProcessExecutionOptions;
    updateExecOptions?: vscode.ProcessExecutionOptions;
    testDebugEnv?: { [key: string]: string }
}

export interface EnvironmentSetting {
    [key: string]: string;
}

class State {
    constructor(folder: WorkspaceFolder) {
        this.state = extension.extensionContext.workspaceState;
        this.te = `${folder.name}.te`;
        this.bc = `${folder.name}.bc`;
        this.bt = `${folder.name}.bt`;
        this.dirty = `${folder.name}.di`;
        this.live = `${folder.name}.li`;
        this.first = `${folder.name}.fi`;
        /* Expanded outline,test tree nodes */
        this.makes = `${folder.name}.${this.buildConfiguration}.mk`;
        this.checks = `${folder.name}.${this.buildConfiguration}.ck`;
    }
    private state : vscode.Memento;

    private te: string;
    private bc: string;
    private bt: string;
    private dirty: string;
    private live: string;
    private first: string;
    private makes: string;
    private checks: string;

    public set testEnvironment(v : string) { this.state.update(this.te, v);}
    public get testEnvironment() : string { return this.state.get(this.te, defaultTestEnvName);}

    public set buildConfiguration(v : string) { this.state.update(this.bc, v);}
    public get buildConfiguration() : string { return this.state.get(this.bc, 'Default');}

    public set buildTarget(v : string | undefined) { this.state.update(this.bt, v);}
    public get buildTarget() : string | undefined { return this.state.get(this.bt);}

    public set liveCheckId(v : string | undefined) { this.state.update(this.live, v);}
    public get liveCheckId() : string | undefined { return this.state.get(this.live);}

    public set configureDirty(v : boolean) { this.state.update(this.dirty, v);}
    public get configureDirty() : boolean { return this.state.get(this.dirty, false);}

    public set ranConfigureInCodebaseLifetime(v : boolean) { this.state.update(this.first, v);}
    public get ranConfigureInCodebaseLifetime() : boolean { return this.state.get(this.first, false);}

    public set expandedMakes(v : number[]) { this.state.update(this.makes, v);}
    public get expandedMakes() : number[] { return this.state.get(this.makes, []);}

    public set expandedChecks(v : number[]) { this.state.update(this.checks, v);}
    public get expandedChecks() : number[] { return this.state.get(this.checks, []);}

  // Reset all the variables saved in the workspace state.
  reset(reloadWindow: boolean = true): void {
    this.state.update(this.te, undefined)
    this.state.update(this.bc, undefined)
    this.state.update(this.bt, undefined)
    this.state.update(this.dirty, undefined)
    this.state.update(this.live, undefined)
    this.state.update(this.first, undefined)
    this.state.update(this.makes, undefined)
    this.state.update(this.checks, undefined)

    if (reloadWindow) {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}

interface Traits {
    overrides_TESTS_ENVIRONMENT: boolean;
    log_drivers: Set<string>;
};

export class FolderConfig implements vscode.Disposable {
    constructor(
        public folder: WorkspaceFolder)
    {
        let c = vscode.workspace.getConfiguration("autotools", folder);
        let allconfigs = c.get<MakefileConfiguration[]>("configurations");
        this.numConfigs = allconfigs?.length ?? 0;
        this.state = new State(folder);
        this.config = allconfigs
            ?.find(c => c.name == this.state.buildConfiguration) ?? {
                name: 'Default',
                top_builddir: this.defaultBuildFolder(),
                isDefault: true,
            };
        this.abs_top_builddir = this.config.top_builddir || this.folder.uri.fsPath;
        if (!path.isAbsolute(this.abs_top_builddir)) {
            this.abs_top_builddir = path.join(this.folder.uri.fsPath, this.abs_top_builddir);
        }
        this._gTestEnvironment = {
            TESTS_ENVIRONMENT: c.get<EnvironmentSetting>("TESTS_ENVIRONMENT"),
            XFAIL_TESTS: c.get<string[]>("XFAIL_TESTS"),
            name: 'g',
            hashCode: 0,
        }

        this.loadedTestEnvironments = c.get<TestEnvironment[]>("test_environments", []);
        cleanupLoadedTestEnvironments(this.loadedTestEnvironments, this._testEnvironments);
        if (this.loadedTestEnvironments.length && loggingLevelApplies('Verbose')) {
            let tenames = this.loadedTestEnvironments
                .map(te => te.name);
            logger.message("Defined autotools.test_environments: " + tenames.join(';'), 'Verbose');
        }
        logger.message(`Selected build for ${this.folder.name} is "${this.buildConfig.name}" in ${this.config.top_builddir}`, 'Verbose');

        this._build_tree = new Make('', {
            diags: vscode.languages.createDiagnosticCollection(`${this.folder.name} @ ${this.buildConfig.name} build rules`),
            diag: new Map(),
            fc: this,
            root: this.abs_top_builddir,
            span: extension.journey,
            allmakes: new Map(),
            makefiles: new Map()
        }, undefined);
        statusBar.setConfiguration(this);
        //extension.onConfigurationSelect(this.config);
        for (const ac of AutoToolsBootstrapTaskProvider.manifests)
            if (util.checkFileExistsSync(path.join(this.folder.uri.path, ac))) {
                this._configureAc = ac;
                break;
            }
        this.tasks.forEach((provider) => provider.changeConfiguration());
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(async e => {
            // console.log("config changed", e);
        }));

        this.tasks.forEach((provider) => this.disposables.push(vscode.tasks.registerTaskProvider(provider.myType, provider)));

        let configureAc = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, (this.configureAc || "configure.ac")));
        this.disposables.push(configureAc.onDidChange(async (e) => await this.regen()));
        this.disposables.push(configureAc.onDidCreate(async (e) => await this.regen()));
        this.disposables.push(configureAc.onDidDelete(async (e) => await this.regen()));
        this._cppConfigurationProvider = new CppConfigurationProvider();
    }
    readonly state: State;
    readonly abs_top_builddir: string;
    _configureAc: string | undefined;
    readonly config: MakefileConfiguration;
    readonly numConfigs: number;
    readonly disposables: Disposable[] = [];
    public dispose() {
        this.disposables.forEach(d => d.dispose());
        this.targetDisposables.forEach((d) => d.dispose());
        this.testController?.deactivate();
        this.testController = undefined;
        this._build_tree.ctx.diags?.dispose();
        extension._projectOutlineProvider.removeFolder(this);
        extension._projectTestSuitesProvider.removeFolder(this);

    }

    public get isAutotoolsProject() : boolean { return !!this._configureAc; }
    public get isBootstrapped() : boolean { return util.checkFileExistsSync(path.join(this.folder.uri.path, "configure"));}
    public get isConfigured() : boolean { return this.autotoolsTask.isConfigured();};

    defaultBuildFolder(): string {
        let config_status = path.join(this.folder.uri.path, "config.status");
        return util.checkFileExistsSync(config_status) ? '' : 'build/Default';
    }

    public getBuildConfigs() : MakefileConfiguration[] {
        return vscode.workspace.getConfiguration("autotools", this.folder)
            .get<MakefileConfiguration[]>("configurations", []);
    }
    public set configureAc(ac: string | undefined) {
        this._configureAc = ac;
    }
    public get configureAc() : string | undefined { return this._configureAc; }

    public get buildConfig() : MakefileConfiguration { return this.config; }


    private _topMakefile: string | undefined;
    public set topMakefile(v: string | undefined) {this._topMakefile = v; }
    public get topMakefile() : string | undefined { return this._topMakefile; }

    /* Test Environments */
    private _gTestEnvironment : TestEnvironment;
    public loadedTestEnvironments: TestEnvironment[];
    private _testEnvironments: TestEnvironment[] = [];
    private _currentTestEnvironment : TestEnvironment = nullTestEnvironment();
    public set currentTestEnvironmentName(name: string) {
        let newEnv = (name ? this._testEnvironments.find(e =>
                e.name == name
        ) : undefined);
        this._currentTestEnvironment = newEnv ?? this._testEnvironments[0];
        this.state.testEnvironment = name;
        this.setBuildEnvPath();
    }
    public get gTestEnvironment() : TestEnvironment { return this._gTestEnvironment; }
    public get currentTestEnvironment() : TestEnvironment { return this._currentTestEnvironment; }
    public get testEnvironments() : TestEnvironment[] { return this._testEnvironments; }
    public getTestEnvironment(name: string) : TestEnvironment {
        return this._testEnvironments.find(k => k.name === name) || this._testEnvironments[0];
    }
    processExecutionOptions(env: TestEnvironment) : vscode.ProcessExecutionOptions {
        if (this.traits.overrides_TESTS_ENVIRONMENT) {
            return {
                cwd: this.abs_top_builddir,
                env: {
                    MAKEFLAGS: "-I " + extension.rulesPath,
                    LOG_DRIVER: extension.testRunner
                } };
        }
        var vars : string[] = [];
        if (this._gTestEnvironment.TESTS_ENVIRONMENT)
            Object.entries(this._gTestEnvironment.TESTS_ENVIRONMENT).forEach(([name,value]) => {
                name &&
                    vars.push(`${name}=` + quote([`${value}`]));
            });
        if (env.TESTS_ENVIRONMENT)
            Object.entries(env.TESTS_ENVIRONMENT).forEach(([name,value]) => {
                name &&
                    vars.push(`${name}=` + quote([`${value}`]));
            });
        return {
            cwd: this.abs_top_builddir,
            env: { TESTS_ENVIRONMENT: vars.join(' '),
                MAKEFLAGS: "-I " + extension.rulesPath,
                LOG_DRIVER: extension.testRunner
            } };
    }
    processDebugEnvironment(env: TestEnvironment) : { [key: string]: string } {
        var vars : EnvironmentSetting = {};
        if (this.traits.overrides_TESTS_ENVIRONMENT)
            return vars;
        if (this._gTestEnvironment.TESTS_ENVIRONMENT)
            Object.entries(this._gTestEnvironment.TESTS_ENVIRONMENT).forEach(([name,value]) => {
            name &&
                (vars[name] = value);
        });
        if (env.TESTS_ENVIRONMENT)
            Object.entries(env.TESTS_ENVIRONMENT).forEach(([name,value]) => {
            name &&
                (vars[name] = value);
        });
        return vars;
    }
    reloadTestEnvironments(c: vscode.WorkspaceConfiguration) {
        this._gTestEnvironment = {
            TESTS_ENVIRONMENT: c.get<EnvironmentSetting>("TESTS_ENVIRONMENT"),
            XFAIL_TESTS: c.get<string[]>("XFAIL_TESTS"),
            name: 'g',
            hashCode: 0,
        }
        this.loadedTestEnvironments = c.get<TestEnvironment[]>("test_environments", []);
        cleanupLoadedTestEnvironments(this.loadedTestEnvironments, this._testEnvironments);
        this.accountForTraits();
        this.currentTestEnvironmentName = this.currentTestEnvironment.name;
        this.resyncTasks();
    }
    /* build+environment path used to uniquely id tests,build,env tuples */
    _buildEnvPath : string = '';
    setBuildEnvPath() : void {
        this._buildEnvPath = `/${this.folder.index}/${this._currentTestEnvironment.hashCode.toString(36)}/${buildDirHash(this.config).toString(36)}`;
    }
    public get buildEnvPath() : string { return this._buildEnvPath; }

    /* Traits management */
    public traits : Traits = {
        overrides_TESTS_ENVIRONMENT: false,
        log_drivers: new Set<string>()
    };
    public updateEnvironmentsForTraits(): void {
        if (this.traits.overrides_TESTS_ENVIRONMENT) {
            let e: TestEnvironment = nullTestEnvironment();
            e.testExecOptions =   this.processExecutionOptions(e);
            e.checkExecOptions =  this.processExecutionOptions(e);
            e.updateExecOptions = this.processExecutionOptions(e);
            e.testDebugEnv = this.processDebugEnvironment(e);
            e.XFAIL_TESTS = this._gTestEnvironment.XFAIL_TESTS??[];
            this._testEnvironments = [e];
        } else {
            var global_XFAIL_TESTS = this._gTestEnvironment.XFAIL_TESTS??[];
            this._testEnvironments = [];
            [nullTestEnvironment(),...this.loadedTestEnvironments].forEach(element => {
                let e: TestEnvironment = {
                    name: element.name,
                    /* Need separate ExecOptions for test and check commands because test run with SUBDIRS env in updateEnvironmentsForCurrentMakefile() */
                    testExecOptions:   this.processExecutionOptions(element),
                    checkExecOptions:  this.processExecutionOptions(element),
                    updateExecOptions: this.processExecutionOptions(element),
                    testDebugEnv:      this.processDebugEnvironment(element),
                    hashCode: 0,
                    XFAIL_TESTS: element.XFAIL_TESTS ? [...global_XFAIL_TESTS,...element.XFAIL_TESTS??[]] : global_XFAIL_TESTS};
                    if (element.dirs)
                        e.dirs = element.dirs;
                    e.hashCode = envHash(e.testExecOptions?.env?.TESTS_ENVIRONMENT ?? '')
                    this._testEnvironments.push(e);
            });
        }
        this.disposeTests();
        this.traits.log_drivers.forEach(d => {
            this._testEnvironments.forEach(e => {
                let driver_flags = `--env-name "${e.name}" --env-id "${(e.hashCode).toString(36)}" --env-keep "$$ME_KEEP_ENV"`;

                e.testExecOptions!.env!['LOG_DRIVER_FLAGS'] = driver_flags;
                e.testExecOptions!.env![d] = extension.testRunner;
                e.testExecOptions!.env![d + '_FLAGS'] = driver_flags;

                e.checkExecOptions!.env!['LOG_DRIVER_FLAGS'] = driver_flags;
                e.checkExecOptions!.env![d] = extension.testRunner;
                e.checkExecOptions!.env![d + '_FLAGS' ] = driver_flags;

                e.updateExecOptions!.env!['am__set_TESTS_bases'] = 'touch $@ && exit 0';
                e.updateExecOptions!.env!['LOG_DRIVER_FLAGS'] = driver_flags;
                e.updateExecOptions!.env![d] = extension.testRunner;
                e.updateExecOptions!.env![d + '_FLAGS'] = driver_flags;
            })
        });
        // this.currentTestEnvironmentName =
        // let newName = setCurrentTestEnvironment(currentTestEnvironmentName);
        this.currentTestEnvironmentName = this.state.testEnvironment; // re-link to the updated env
        this.setBuildEnvPath();
        // extension.setTestEnvironmentName(newName);
    }
    public accountForTraits(): void {
        this.updateEnvironmentsForTraits();
    }
    disposeTests() {
        this._testEnvironments.forEach(e => {
            e.debug?.dispose(); e.debug = undefined;
            e.run?.dispose(); e.run = undefined;
        });
    }
    clearTraits() {
        this.traits = {
            overrides_TESTS_ENVIRONMENT: false,
            log_drivers: new Set<string>()
        };
    }

    get wsConfig() : vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration("autotools", this.folder); }

    // The configuration cache is stored in ${top_builddir}/.vscode/all.cache
    // Ie, each config is keyed to the configuration and target
    // TODO: The user should have the option to turn off the cache because it may become decoherent with the
    // workspace when the source is changed (eg, diff branch checked out) between vscode reloads.
    public get cachePath(): string | undefined {
        // Keep the configurationCache in the configuration directory?
        //   true : file will be saved as ${top_builddir}/.vscode/all.cache,
        //          and loaded at next reload, before dry-running
        //   false: file will be not be saved
        if (!this.wsConfig.get<boolean>("keepConfigurationCache", false))
            return undefined;

        let cachePath: string = path.join(this.abs_top_builddir, ".vscode");
        util.createDirectorySync(cachePath);
        return cachePath;
    }
    public get dryRunPath(): string | undefined {
        // Keep the dry-run output in the configuration directory?
        //   true : file will be saved as ${top_builddir}/.vscode/all.dryrun.log
        //   false: file will be not be saved
        if (!this.wsConfig.get<boolean>("keepDryRuns", false))
            return undefined;

        let cachePath: string = path.join(this.abs_top_builddir, ".vscode");
        util.createDirectorySync(cachePath);
        return cachePath;
    }

    public get problemMatchers(): string[] { return this.config.problemMatchers || []; }

    // Analyze the settings of the current makefile configuration and the global workspace settings,
    // according to various merging rules and decide what make command and build log
    // apply to the current makefile configuration.
    // private initialConfigurationAttempted : boolean = false;

    public async analyzeConfigureParams(parentSpan: Span, reload: boolean, failIfUnconfigured : boolean): Promise<boolean> {
        let result : string;
        let hasMakefile : boolean = false;
        let span = telemetry.startSpan("an", parentSpan);

        this.state.configureDirty = false;

        let isAutotools = this.isAutotoolsProject;
        let bootstrapped = isAutotools && this.isBootstrapped;
        let configured = bootstrapped && this.isConfigured;
        // If initially not configured, an attempt is made to bootstrap and configure.
        // This flag avoids the normal make.configure() call at the end of activate()
        // proj is configured already at activation
        // this.initialConfigurationAttempted ||= !configured && !failIfUnconfigured;

        if (isAutotools) {

            if (bootstrapped) {
                if (configured || (!failIfUnconfigured && await this.configure(span))) {
                    this.topMakefile = findMakefile(this.abs_top_builddir);
                    if (!reload) {
                        let kbUrl = await this.kbUrl();
                        if (this.topMakefile) {
                            this.logMakeCmd();
                            result = "ok";
                            hasMakefile = true;
                        } else {
                            logger.message(`${this.folder.name} configuration succeeded but there is no makefile.`);
                            logger.message('KB: ' + kbUrl.toString(true) + '#no-makefile-found', "Normal");
                            /* Override the bootstrapped context so the welcome button "Bootstrap is shown" */
                            telemetry.setSpanStatus(span, SpanStatusCode.ERROR, "no-makefile");
                            result = "configured-noMakefile"
                        }
                    } else
                        result = "oks";
                } else {
                    result = "configure-failed";
                }
            } else {
                result = "not-bootstraped";
                logger.message('The project is not yet bootstrapped.');
            }
            if (!reload)
                statusBar.setStatus(this.isAutotoolsProject ?
                    (hasMakefile ? ui.UIStatus.OK : ui.UIStatus.NO_MAKEFILE) :
                    ui.UIStatus.NON_AUTOTOOLS, this);
        } else {
            result = "n/a";
        }
        telemetry.endSpanWithStatus(span, hasMakefile ? SpanStatusCode.OK : SpanStatusCode.ERROR, result, {anRes: result});
        return Promise.resolve(hasMakefile);
    }

    public async parseBuildConfig(span: Span, triggeredBy: make.TriggeredBy) : Promise<void> {
        await make.configure(span, triggeredBy, this);
    }

    logMakeCmd(): void {
        if (this.config.makeArgs)
            logger.message(`Make cmd (${this.topMakefile}): '${makePath} ${this.config.makeArgs.join(" ")}' for configuration "${this.buildConfig.name}"`, "Debug");
        else
            logger.message(`Make cmd (${this.topMakefile}): '${makePath}' for configuration "${this.buildConfig.name}"`, "Verbose");
    }

    /* TASKS */
    readonly autotoolsTask = new AutoToolsBootstrapTaskProvider(this);
    readonly buildTasks = new AutoToolsBuildTaskProvider(this);
    readonly testTasks = new AutoToolsTestTaskProvider(this);
    readonly checkTasks = new AutoToolsCheckTaskProvider(this);
    readonly tasks: MyTaskProvider[] = [
        this.autotoolsTask,
        this.buildTasks,
        this.testTasks,
        this.checkTasks
    ];
    private isTreeUpdate: boolean = false;
    public updateTasks(newTree: boolean): void {
        let updateBadge : boolean = false;
        this.tasks.forEach((provider) => updateBadge = provider.update() || updateBadge);

        extension._projectOutlineProvider.updateTargets(this, this.isTreeUpdate);
        extension._projectTestSuitesProvider.updateTargets(this, this.isTreeUpdate);
        this.isTreeUpdate = true;
        this.updateOutlineBadge();

        this.updateTestSuite(this.build_tree, this._build_tree, true);
        this.testController?.onOpenedDocument().then(
            ok => {},
            notok => {});
        this.testController?.restoreLiveCheck();
    }

    /* PACKAGE NAME / URL */
    public pkginfo : make.pkgInfo | undefined;
    _kbUrlStatic : vscode.Uri = vscode.Uri.from({
        scheme: 'https',
        authority: 'autotools.mergesium.com',
        path: `/kb/${this.folder.name}`});
    async kbUrl() : Promise<vscode.Uri> {
        if (!this.pkginfo)
            await this.readPkgInfo();

        if (!this.pkginfo)
            return Promise.resolve(this._kbUrlStatic);

        this._kbUrlStatic = vscode.Uri.from({
            scheme: 'https',
            authority: 'autotools.mergesium.com',
            path: '/kb/' + util.slugify(this.pkginfo?.name ?? 'unknown'),
            // The s- prefix matches my_kramdown_patch
            // Used for headings that start with digits (1.0.0) because html element ids cannot begin with non letter
            query: this.pkginfo?.version.match(/^a-zA-Z/) ?
                'v=' + util.slugify('s-' + this.pkginfo?.version) :
                this.pkginfo?.version ? 'v=' + util.slugify(this.pkginfo?.version) : undefined
        });
        return Promise.resolve(this._kbUrlStatic);
    }
    async gotoKnowledgeBase() {
        let kburl = await this.kbUrl();
        vscode.commands.executeCommand('vscode.open', kburl.toString(true));
    }
    getProjectName() : string {
        if (this.pkginfo) {
            if (this.pkginfo.version)
                return `${this.pkginfo.name} ${this.pkginfo.version}`;
            else
                return `${this.pkginfo.name}`;
        }
        return this.folder.name;
    }
    // Force read pkginfo even if already set, used when configure.ac changes
    public async readPkgInfo() : Promise<void> {
        this.pkginfo = await make.getPackageJSON(this).catch<undefined>(() =>
            Promise.resolve(undefined));
    }

    /* Test stats interface */
    public failStatUpdate(oldresult: make.TRS, result: make.TRS) {
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
    private unsupported_log_count : number = 0;
    // return true if the Outline badge should update
    public updateTRSInPanel(old: make.TestResult | undefined, goal: Goal, dir: string) : boolean {
        /* The ?? defaults are needed when the test is not using my LOG_DRIVER
         * .. the TRS in the file will not have the hashCode
         *
         */
        let teIndex = this._currentTestEnvironment.hashCode;
        let current : TRS | undefined = goal.trs!.results.get(teIndex);
        let oldTRS = old?.results.get(teIndex) ?? TRS.NONE;
        if (old !== undefined && current == undefined  && goal.trs!.global != TRS.NONE) {
            /* ie, There *is* a trs file, but lacks envids */
            if (this.unsupported_log_count++ < 4) {
                logger.message(`ERROR: The test ${dir}/${goal.goal} did not use the ${Extension.whoami} LOG_DRIVER. Per-environment results not available.`);
                telemetry.setSpanStatus(extension.journey, SpanStatusCode.ERROR, "unknown ?_LOG_DRIVER");
            }
        } else
        if (old === undefined || (current ?? TRS.NONE) != oldTRS) {
//                {authority: Extension.whoami, scheme: 'test', path: '/' + dir, query: goal.goal}));
            //this.suiteDecorator.update(vscode.Uri.from(
            //    {authority: Extension.whoami, scheme: 'check', path: '/' + dir, query: 'test-suite.log'}));
            if (old !== undefined) {// Don't update when TRS's are initially read from disk
                extension.suiteDecorator.update(goal.getURI());
                this.failStatUpdate(oldTRS, current ?? TRS.NONE);
            }
            // Don't update the test suites. They are auto summarized
            return true;
        }
        return false;
    }

    public async bootstrapWithPrompt(span: Span) : Promise<void>  {
        if (!this.isBootstrapped) {
            let cmd = this.autotoolsTask.bootstrap_cmd();
            if (cmd) {
                const doit: string = localize("autotools.bootstrap.me", "Bootstrap");
                const setit: string = localize("autotools.edit.setting", "Setting...");
                await vscode.window.showWarningMessage(
                    localize("autotools.want.bootstrap", "Project '{0}' needs to be bootstrapped ('{1}').",
                    this.folder.name,
                    cmd.join(' ')),
                    doit,
                    localize("autotools.cancel", "Cancel"), setit).then(async (value) => {
                    if (value === doit) {
                        let te = await this.autotoolsTask.bootstrap();
                        te && extension.running.set(te, span);
                    } else if (value === setit) {
                        openSettings("autotools.autoBootstrap", null, true);
                    }
                });
            }
        }
    }
    public async regen() : Promise<void> { this.autotoolsTask.regen(); }

    /* Task STATE MACHINE */
    public async taskFSM(e: vscode.TaskProcessEndEvent, definition: AutotoolsTask, span: Span, task: vscode.Task) : Promise<void> {
        await this.autotoolsTask.autotoolsDone(span, task.execution,
            (typeof e.exitCode == 'number') ? e.exitCode : (e.exitCode ? 1 : 0));
        if (!e.exitCode) {
            if (definition?.action == "bootstrap") {
                let r = await this.analyzeConfigureParams(span, false, false) &&
                    !await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange, this);
                if (r) this.testController?.onSavedAll();
            } else if (definition?.action == "reautomake") {
                if (!e.exitCode) {
                    this.autotoolsTask.recheck(telemetry.startSpan('recheck', span));
                }
            } else if (definition?.action == "regen") {
                if (!e.exitCode) {
                    this.configure(telemetry.startSpan('config+', span));
                }
            } else if (definition?.action == "recheck" || definition?.action == "configure") {
                let r = await this.analyzeConfigureParams(span, false, true) &&
                    !await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange, this);
                if (r) this.testController?.onSavedAll();
            }
            span && telemetry.setSpanStatus(span, SpanStatusCode.OK);
        } else {
            ui.getUI().setLoading(ui.UIStatus.ERR, this);
            span && telemetry.setSpanStatus(span, SpanStatusCode.ERROR, `status ${e.exitCode}`);
        }
    }

    /* Actions */
    public async configure(span: Span): Promise<boolean> {
        extension.needTaskFetchBugWorkaround = false;
        var success =  await this.autotoolsTask.configure(span);
        if (!success) {

            logger.message('Configure failed. Review the Terminal tab for cause.', "Normal");
            logger.message('Configuring can be re-attempted with "Autotools: Configure"', "Normal");
            logger.message('KB: ' + this._kbUrlStatic.toString(true) + '#config-fail', "Normal");
        }
        //this.updateMakefileFilePresent(success);
        return success;
    };

    /* Build Tree */
    readonly _build_tree : Make;
    public updateBuildTree (): void {
        if (!this.build_tree.hasStats) {
            countStats(this._build_tree);
            this.build_tree.hasStats = true;
        }

        extension.updateCppToolsProvider();
        if (this.build_tree.stats.checks) {
            if (!this.testController) {
                this.testController = new MyTestController(this,
                    `${Extension.whoami}.${this.folder.index}`, `Autotools tests - ${this.folder.name}`, this.state.liveCheckId);
            } else {
                this.testController?.deactivate();
                this.testController?.restart();
            }
        } else {
            this.testController?.deactivate();
            this.testController = undefined;
        }
        this.updateTasks(true);
    }
    public get build_tree() : Make { return this._build_tree; }
    public resyncTasks() : void { this.updateTasks(false);}

    /* Initiate Parsing */
    /* returns whether configuration was done or not (bool) */
    private isActive: boolean = false;
    private _activatedEvent: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
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
    public async parse(span: Span) : Promise<void> {
        if (!this.topMakefile) {
            if (!this.autotoolsTask.isWorking) // if bootstrapping was started above, don't flag now. the bootstrap result will tell.
                ui.getUI().setLoading(this.isAutotoolsProject ? ui.UIStatus.ERR : ui.UIStatus.NON_AUTOTOOLS, this);
            this.isActive = true;
            this._activatedEvent.fire(this.isActive);
            return;
        }
        let validact = telemetry.startSpan("deferConfig", span);
        await make.configure(validact, make.TriggeredBy.cleanConfigure, this);
        validact.end();
        this.isActive = true;
        this._activatedEvent.fire(this.isActive);
    }

    public outputLogHeader() : void {

        if (this.pkginfo/* && !currentMakefileConfiguration*/) {
            logger.message(localize('autotools.package.coordinates', "Package \"{0}\" version {1} - bug reports: {2}, url: {3}",
            this.pkginfo.name || "unknown", this.pkginfo.version || "unk", this.pkginfo.bugreport || "unknown", this.pkginfo.url || "unknown"), "Normal");
            logger.message(localize('autotools.ref.kb', "Knowledge Base: {0}", this._kbUrlStatic.toString(true)), "Normal");
        } else {
            logger.message(localize('autotools.folder.coordinates', "Folder \"{0}\"", this.folder.name));
        }
        if (this._gTestEnvironment.XFAIL_TESTS?.length)
            logger.message("Defined autotools.XFAIL_TESTS: " + this._gTestEnvironment.XFAIL_TESTS.join(";"), "Verbose");
    }
    public async start(span: Span) : Promise<void> {
        if (this.isAutotoolsProject) {
            extension._projectOutlineProvider.updateTargets(this, false);
            extension._projectTestSuitesProvider.updateTargets(this, false);
            await this.analyzeConfigureParams(span, false, false);
            this.outputLogHeader();
            this.bootstrapWithPrompt(span);
        }
    }

    private _buildTargets: Map<string, Map<string,Goal>> = new Map();
    public get buildTargets() : Map<string, Map<string,Goal>> { return this._buildTargets; }

    public updateOutlineBadge() : void {
        // updateOutlineStats(numFails, numSuspect, numTests, numUnknown);
        updateWelcomeContexts();

        /* Todo - update the badge */
    }

    /* Folder settings */
    /* Current Target */
    // The current target is the read from the default built task,
    // or the first Linked_binary target
    public async getCurrentTarget(): Promise<Goal> {
        // FIXME: vscode bug. Initial vscode.tasks.fetchTasks does not resolve tasks.json
        // Second run, it does. This means launch.json using ${command:autotools.default_program}
        // debugs a different program (ie, the first binary) the first time as the second
        // (the default task from tasks.json)
        let tasks = await vscode.tasks.fetchTasks({type: "build"});

        // Find the default build task, and return its target
        let default_build = tasks.find(task => task.definition?.target && task.group?.isDefault);
        if (default_build) {
            // assert(default_build.definition);
            const definition: BuildTask = <any>default_build.definition;
            assert(definition && definition.target, "default_build should have definition and target", default_build);
            if (!definition?.target)
                return Promise.reject();
            let fc = findFolderConfig(vscode.Uri.file(definition.target.builddir));
            if (fc) {
                let goal = fc.buildTargets
                    .get(definition.target.builddir)
                    ?.get(definition.target.goal);
                if (goal)
                    return Promise.resolve(goal);
            }
            return Promise.reject("Target not found");
        }

        // If no default build task, return the make target that is a linked binary
        for (const[dir, targets] of this.buildTargets) {
            for (let [name, goal] of targets) {
                if (goal.flags & Goal.Flags.Linked_binary) {
                    assert(goal.task, "Current target goal should have task(s)", goal);
                    if (goal.task instanceof vscode.Task)
                        return Promise.resolve(goal);
                    return Promise.reject();
                }
            }
        }

        // No current build target
        const showme: string = localize("autotools.showme", "Show me");
        vscode.window.showErrorMessage(
            localize("autotools.no.debuggable", "No debuggable program was found. Try selecting a default build task."),
            localize("autotools.cancel", "Cancel"),
            showme).then((value) => {
            if (value === showme) {
                vscode.commands.executeCommand("workbench.action.tasks.configureDefaultBuildTask");
            }
        });
        return Promise.reject("Testing - no current build target");
    }

    public clearBuildTargets(span: Span) {
        this.clearTraits();
        this._build_tree.ctx.span = span;
        this._build_tree.ctx.diags.clear();// set(undefined);
        this._build_tree.ctx.diag.clear();
        this._build_tree.ctx.allmakes.set(this._build_tree.dir, this._build_tree);
        this._build_tree.goals.clear();
        this._build_tree.seenVars.clear();
        this._build_tree.submake.clear();
        this._build_tree.ctx.allmakes.clear();
        this._build_tree.ctx.allmakes.set('', this._build_tree);
        this._build_tree.test_suite = undefined;
        this._build_tree.stats = {programs: 0, sharedlibs: 0, tests: 0, testbins:0, checks: 0, subdirs: 0};
        this._build_tree.hasStats = false;
        this.targetDisposables.forEach(d => d.dispose());
        this.buildTargets.clear();
    }
    public updateWatchers() {
        // let c = fc.buildConfig;
        this.targetDisposables.forEach((d) => d.dispose());
        this.targetDisposables = Array.from(this.buildTargets.keys())
            .map( (p) => {
                const builddir = path.join(this.abs_top_builddir, p);
                if (!this.abs_top_builddir) // In-tree build, watch the same dir for both
                    return new util.MyFileWatcher(builddir, (e, f) => {
                        if (f == 'Makefile.am' || (f.endsWith('.in') && f != 'Makefile.in')) {
                            /* Regen if config*.in files change, other than Makefile.in which is updated due to Makefile.am */
                            this.autotoolsTask.reautomake(telemetry.startSpan("upAM", extension.journey));
                        }
                        if (f.endsWith(".trs"))
                            extension.trsChange(this, vscode.Uri.file(path.join(builddir,f)));
                    });
                else
                    return new util.MyFileWatcher(builddir, (e, f) => {
                        if (f.endsWith(".trs"))
                            extension.trsChange(this, vscode.Uri.file(path.join(builddir,f)));
                    });

            });
            if (this.abs_top_builddir) {// Separate watcher for makes
                this.targetDisposables.push(...Array.from(this.buildTargets.keys())
                .map( (p) => {
                    const srcdir = path.join(this.folder.uri.path, p);
                    return new util.MyFileWatcher(srcdir, (e, f) => {
                        if (f == 'Makefile.am' || (f.endsWith('.in') && f != 'Makefile.in')) {
                            /* Regen if config*.in files change, other than Makefile.in which is updated due to Makefile.am */
                            this.autotoolsTask.reautomake(telemetry.startSpan("upAM", extension.journey));
                        }
                    });
                }));
            }
    }
    private targetDisposables : vscode.Disposable[] = [];

    /* Intellisense Data */
    private readonly _cppConfigurationProvider : CppConfigurationProvider;
    public get cppConfigurationProvider() : CppConfigurationProvider { return this._cppConfigurationProvider; }

    // Clear cached config data
    public resetCppToolsProvider(): void {
        let cache = this._cppConfigurationProvider.getCustomConfigurationProvider();
        cache.fileIndex.clear();
        cache.workspaceBrowse = {
            browsePath: [],
            compilerArgs: [],
            compilerPath: undefined,
            standard: undefined,
            windowsSdkVersion: undefined
        };
        this._cppConfigurationProvider.setCustomConfigurationProvider(cache);
        // workspaceBrowseConfiguration
        // this.updateCppToolsProvider();
    }


    public buildCustomConfigurationProvider(item: toolParser.CustomConfigProviderItem): void {
        let provider: cpptools.CustomConfigurationProvider = this._cppConfigurationProvider.getCustomConfigurationProvider();

        const newSrc: cpp.SourceFileConfiguration = {
            defines: item.defines,
            standard: item.standard,
            includePath: item.includes,
            forcedInclude: item.forcedIncludes,
            intelliSenseMode: item.intelliSenseMode,
            compilerPath: item.compilerFullPath,
            compilerArgs: item.compilerArgs,
            windowsSdkVersion: item.windowsSDKVersion
        };

        // cummulativeBrowsePath incorporates all the files and the includes paths
        // of all the compiler invocations of the current configuration
        item.files.forEach(filePath => {
            let uri: vscode.Uri = vscode.Uri.file(filePath);
            let sourceFileConfigurationItem: cpptools.SourceFileConfigurationItem = {
                uri,
                configuration: newSrc,
                compileCommand: {
                   command: item.line,
                   directory: item.currentPath,
                   file: filePath
                }
            };

            // These are the configurations processed during the current configure.
            // Store them in the 'delta' file index instead of the final one.
            provider.fileIndex.set(path.normalize((process.platform === "win32") ? uri.fsPath.toUpperCase() : uri.fsPath),
                                                  sourceFileConfigurationItem);
            this._cppConfigurationProvider.logConfigurationProviderItem(sourceFileConfigurationItem);

            let folder: string = path.dirname(filePath); // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(folder)) {
                provider.workspaceBrowse.browsePath.push(folder);
            }
        });

        item.includes.forEach(incl => { // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(incl)) {
                provider.workspaceBrowse.browsePath.push(incl);
            }
        });

        item.forcedIncludes.forEach(fincl => {
            let folder: string = path.dirname(fincl); // FIXME: uses a Set, avoid the lsearch
            if (!provider.workspaceBrowse.browsePath.includes(folder)) {
                provider.workspaceBrowse.browsePath.push(fincl);
            }
        });
    }

    /* Test Controller */
    testController : MyTestController | undefined;
    updateTestSuite(sub: Make, parent: Make, top: boolean): void {
        //        let c = configuration.getCurrentMakefileConfiguration();
        for (let submake of sub.submake.values()) {
            if (submake.test_suite?.test) {
                // add it to my parent if I don't have suite
                // This can happen if 1+ intermediate dir has no TESTS
                let suiteparent = sub.test_suite?.test ?? parent.test_suite?.test;
                if (suiteparent)
                    this.testController!.addSubTest(suiteparent, submake.test_suite.test);
            }
            //if (submake.test_suite?.test)
            this.updateTestSuite(submake, sub.test_suite ? sub : parent, top && !sub.test_suite);
        }
        if (sub.test_suite && sub.test_suite.test) {
            //let logpath = path.join(c.top_builddir, sub.dir);
            sub.test_suite.depends?.forEach((test) => {
                sub.test_suite?.test && this.testController!.addTest(this.buildConfig, sub.dir, sub.test_suite.test, test)});
        }
        if (top && sub.test_suite?.test)
            this.testController!.update(sub.test_suite.test);
    }

}

let configs : Map<WorkspaceFolder, FolderConfig> = new Map();

export function loadAllFolders() : void {
    vscode.workspace.workspaceFolders?.map((f,i) => configs.set(f,new FolderConfig(f, )));
}

export async function onWorkspaceChange(e: vscode.WorkspaceFoldersChangeEvent, span: Span) : Promise<void> {
    e.removed.forEach(f => {
        let fc = configs.get(f);
        if (fc) {
            fc.dispose();
            configs.delete(f);
        }
    });
    updateWelcomeContexts();
}

// export async function parseAllFolders(span: Span) : Promise<void> {
//     for (const [k,v] of configs) {
//         await v.parse(span);
//     }
// }

export async function startAllFolders(span: Span) : Promise<void> {
    return startFolders(span, Array.from(configs.values()));
}
export async function startFolders(span: Span, configs: FolderConfig[]) : Promise<void> {
    extension.createPanel();
    for (const v of configs) {
        if (v.isAutotoolsProject)
            statusBar.show();
        await v.start(span);
        await v.parse(span);
    }
    updateWelcomeContexts();
}

export function hasAnyAutotoolsFolders() : boolean {
    for (const [k,v] of configs) {
        if (v.isAutotoolsProject)
            return true;
    }
    return false;
}
export function findFolderConfig(uri: vscode.Uri) : FolderConfig | undefined {
    let folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? configs.get(folder) : undefined;
}
export function getFolderConfig(folder: WorkspaceFolder) : FolderConfig
{
    let fc = configs.get(folder);
    if (fc) return fc;
    let e = new Error("getting FolderConfigu for unk folder");
    telemetry.logException(e, extension.journey);
    throw e;
}

function updateWelcomeContexts() : void {
    let haveParallelHarnesses : boolean = false;
    let haveTestEnvironments : boolean = false;
    let haveAutotoolsProjects : number = 0;
    let allConfigured : boolean = false;
    let anyBusyParsers: boolean = false;
    let numFails : number = 0;
    let numSuspect : number = 0;
    let numTests : number = 0;
    let numUnknown : number = 0;
    let at : FolderConfig | undefined;
    for (const [k,v] of configs) {
        haveParallelHarnesses ||= !!v.build_tree.stats.checks;
        haveAutotoolsProjects += v.isAutotoolsProject ? 1 : 0;
        haveTestEnvironments ||= !!v.loadedTestEnvironments.length;
        anyBusyParsers ||= v.autotoolsTask.isWorking;
        allConfigured &&= v.isConfigured;
        numTests += v.testTasks.numTests;
        numSuspect += v.testTasks.numSuspect;
        numFails += v.testTasks.numFails;
        numUnknown += v.testTasks.numUnknown;
        if (v.isAutotoolsProject) at = v;
    }
    vscode.commands.executeCommand('setContext', "autotools:haveParallelHarness", haveParallelHarnesses ? 1 : 2);
    vscode.commands.executeCommand('setContext', "autotools:haveEnvironments", haveTestEnvironments ? 1 : 2);
    vscode.commands.executeCommand('setContext', "autotools:haveManifest", haveAutotoolsProjects ? 1 : 2);
    vscode.commands.executeCommand("setContext", "autotools:makefileFilePresent", allConfigured ? 1 : 2);
    vscode.commands.executeCommand("setContext", "autotools:hasTargets", !anyBusyParsers ? 1 : 2);

    if (haveAutotoolsProjects == 1 && at) {
        /* If there is a single autotools project, enable the welcome screens */
        vscode.commands.executeCommand("setContext", "autotools:packageHasURL",
            at.pkginfo?.url ? 1 : 2);
        vscode.commands.executeCommand("setContext", "autotools:packageHasIssues",
            at.pkginfo?.bugreport ? 1 : 2);
        vscode.commands.executeCommand("setContext", "autotools:isConfigured",
            at.isConfigured ? 1 : 2);
    }

    updateOutlineStats(numFails, numSuspect, numTests, numUnknown);
}

function updateOutlineStats(
    numFails : number,
    numSuspect : number,
    numTests : number,
    numUnknown : number) : void {
    let view = extension._projectTestSuitesView;
    if (!view)
        return;

    if (numFails) {
        view.badge =
            {tooltip:
                localize("autotools.failing.tests", "{0}/{1} tests FAIL",
                    numFails, numTests),
            value: numFails};
    } else if (numSuspect) {
        view.badge =
            {tooltip:
                localize("autotools.suspect.tests", "{0}/{1} tests are suspect (XPASS/XFAIL/ERROR)",
                    numSuspect, numTests),
            value: numSuspect};
        // FIXME: this miscounts when TRS file is deleted (3x inotify on test updates). Re-test
        // not commented out because "No tests available is not a better message than a wrong count"
    } else if (numTests && numUnknown) {
        view.badge =
            {tooltip:
                localize("autotools.unknown.tests", "{0}/{1} tests are available/not yet run",
                    numUnknown, numTests),
            value: numUnknown};
    } else {
        view.badge =
            {tooltip:
                localize("autotools.no.tests", "No tests available"),
            value: 0
        };
    }
}

export function findFolderConfigByIndex(folderIndex: number) : FolderConfig {
    for (const [folder,fc] of configs) {
        if (folder.index == folderIndex) return fc;
    }
    let e = new Error("Non-existent folderIndex");
    telemetry.logException(e, extension.journey);
    throw e;
}

export function findFolderConfigByTarget(uri: vscode.Uri) : FolderConfig | undefined{
    for (const [folder,fc] of configs) {
        let fileIndex = fc.cppConfigurationProvider.getCustomConfigurationProvider().fileIndex;
        if (fileIndex.has(uri.path))
            return fc;
    }
    let e = new Error("Non-existent folder for target");
    telemetry.logException(e, extension.journey);
    return undefined;
}

// The default make tool is "make"
let makePath: string = "make";
export function getMakePath(): string { return makePath; }
export function setMakePath(path: string): void { makePath = path; }

// Read the path (full or directory only) of the make tool if defined in settings.
// It represents a default to look for if no other path is already included
// in "autotools.configurations.makePath".
async function readMakePath(): Promise<void> {
    setMakePath(await util.getSettingOr<string>(null, "makePath", 'make'));
}

let loggingLevel: string | undefined;
export function getLoggingLevel(): string | undefined { return loggingLevel; }
export function setLoggingLevel(logLevel: string): void { loggingLevel = logLevel; }

// Read from settings the desired logging level for the Makefile Tools extension.
export function readLoggingLevel(): void {
    loggingLevel = util.getSettingOr<string>(null, "loggingLevel", 'Normal');
    logger.message(`Logging level: ${loggingLevel}`, "Verbose");
}

export let cppProvider : string;
export function readCppProvider() : void {
    let c = vscode.workspace.getConfiguration("C_Cpp.default", null);
    cppProvider = c?.get<string>("configurationProvider", '');
}
// prompt to clean when the active configuration changes?
//   true : prompt, clean if user confirms
//   false: no prompting, no cleaning
let promptClean: boolean;
export function getPromptClean(): boolean { return promptClean; }
export function readpromptClean() : void {
    promptClean = util.getSettingOr<boolean>(null, "promptClean", true);
}

let traceLiveTestRuns: boolean;
export function gettraceLiveTestRuns(): boolean { return traceLiveTestRuns; }
export function readtraceLiveTestRuns() : void {
    traceLiveTestRuns = util.getSettingOr<boolean>(null, "traceLiveTestRuns", false);
}

let autoreconfWarnCross: boolean;
export function getautoreconfWarnCross(): boolean { return autoreconfWarnCross; }
export function readautoreconfWarnCross() : void {
    autoreconfWarnCross = util.getSettingOr<boolean>(null, "autoreconfWarnCross", false);
}

let autoreconfWarnPortability: boolean;
export function getautoreconfWarnPortability(): boolean { return autoreconfWarnPortability; }
export function readautoreconfWarnPortability() : void {
    autoreconfWarnPortability = util.getSettingOr<boolean>(null, "autoreconfWarnPortability", false);
}

let autoreconfWarnObsolete: boolean;
export function getautoreconfWarnObsolete(): boolean { return autoreconfWarnObsolete; }
export function readautoreconfWarnObsolete() : void {
    autoreconfWarnObsolete = util.getSettingOr<boolean>(null, "autoreconfWarnObsolete", false);
}

let autoreconfWarnOverride: boolean;
export function getautoreconfWarnOverride(): boolean { return autoreconfWarnOverride; }
export function readautoreconfWarnOverride() : void {
    autoreconfWarnOverride = util.getSettingOr<boolean>(null, "autoreconfWarnOverride", false);
}

let autoreconfWarnUnsupported: boolean;
export function getautoreconfWarnUnsupported(): boolean { return autoreconfWarnUnsupported; }
export function readautoreconfWarnUnsupported() : void {
    autoreconfWarnUnsupported = util.getSettingOr<boolean>(null, "autoreconfWarnUnsupported", true);
}

let autoreconfWarnGnu: boolean;
export function getautoreconfWarnGnu(): boolean { return autoreconfWarnGnu; }
export function readautoreconfWarnGnu() : void {
    autoreconfWarnGnu = util.getSettingOr<boolean>(null, "autoreconfWarnGnu", false);
}

let autoreconfTool: string = 'autoreconf';
export function getAutoreconfTool(): string { return autoreconfTool; }
export async function readAutoreconfTool() : Promise<void> {
    autoreconfTool = await util.getSettingOr<string>(null, "autoreconfTool", 'autoreconf');
}

export function autoreconfCmd(): string[] {
    let cmd : string[] = [];
    cmd.push(getAutoreconfTool());
    if (getautoreconfWarnCross()) cmd.push("-Wcross");
    if (getautoreconfWarnPortability()) cmd.push("-Wportability");
    if (getautoreconfWarnObsolete()) cmd.push("-Wobsolete");
    if (getautoreconfWarnOverride()) cmd.push("-Woverride");
    if (getautoreconfWarnGnu()) cmd.push("-Wgnu");
    if (!getautoreconfWarnUnsupported()) cmd.push("-Wno-unsupported");
    return cmd;
}

// function defaultBuildFolder(): string {
//     let config_status = util.resolvePathToRoot("config.status");
//     return util.checkFileExistsSync(config_status) ? '' : 'build/Default';
// }

function findMakefile(abs_top_builddir: string): string | undefined {
    // top_builddir is resolved to either a subdirectory of the workspace or an absolute path.

    // The make file is in top_builddir
    // and is named "Makefile" or "makefile" or "GNUmakefile".
    let makeFileTest: string | undefined;
    // filename of makefile relative to top_builddir
    let topMakefile: string | undefined;
    let relativeMakefile: string | undefined;
    let makefileExists : boolean = false;
    relativeMakefile = "GNUmakefile";
    makeFileTest = path.join(abs_top_builddir, relativeMakefile);
    makefileExists = util.checkFileExistsSync(makeFileTest);
    if (makefileExists)
        topMakefile = relativeMakefile;

    relativeMakefile = "Makefile";
    makeFileTest = path.join(abs_top_builddir, relativeMakefile);
    makefileExists = util.checkFileExistsSync(makeFileTest);

    if (!makefileExists) {
        relativeMakefile = "makefile";
        makeFileTest = path.join(abs_top_builddir, relativeMakefile);
        makefileExists = util.checkFileExistsSync(makeFileTest);
    }
    if (!makefileExists)
        relativeMakefile = topMakefile;
    return relativeMakefile;
}

//export function setMakefileConfigurations(configurations: MakefileConfiguration[]): void { makefileConfigurations = configurations; }

// Assign names to any unnamed environments
export function cleanupLoadedTestEnvironments(loaded: TestEnvironment[], configured: TestEnvironment[]) : void {
    let unnamedConfigurationId: number = 0;
    const unnamedPrefix = "Unnamed";

    // Collect unnamed configurations (probably) defined by the extension earlier,
    // to make sure we avoid duplicates in case any new configuration is in need of a name.
    let unnamedConfigurationNames: string [] = configured
        .map(k => k.name || unnamedPrefix)
        .filter(item => (item && item.startsWith(unnamedPrefix)));

    loaded.forEach(element => {
        if (!element.name) {
            // Just considering the possibility that there are already unnamed configurations
            // defined with IDs other than the rule we assume (like not consecutive numbers, but not only).
            // This may happen when the user deletes configurations at some point without updating the IDs.
            unnamedConfigurationId++;
            let autoGeneratedName: string = `${unnamedPrefix}-${unnamedConfigurationId}`;
            while (unnamedConfigurationNames.includes(autoGeneratedName)) {
                unnamedConfigurationId++;
                autoGeneratedName = `${unnamedPrefix}-${unnamedConfigurationId}`;
            }

            element.name = autoGeneratedName;
            logger.message(`WARNING: Defining name ${autoGeneratedName} for unnamed test environment ${element}.`);
        }
    });
}



const defaultTestEnvName : string = "<no-env>";
function nullTestEnvironment() : TestEnvironment {
        return {
            name: defaultTestEnvName,
            TESTS_ENVIRONMENT: {},
            hashCode: envHash('')}
}

export let currentGoals : Goal[] | undefined;
export let currentGoalsBins : Goal[] | undefined;
export let currentGoalsTests : Goal[] | undefined;
export function setCurrentGoalBins(goals: Goal[] | undefined) {
    currentGoalsBins = goals;
    currentGoals =
        currentGoalsBins == undefined && currentGoalsTests == undefined ?
        undefined : [...currentGoalsBins??[], ...currentGoalsTests??[]];
    vscode.commands.executeCommand('setContext', "autotools:filterByTarget",
        (currentGoals && (currentGoals.length != 0)));
}
export function setCurrentGoalTests(goals: Goal[] | undefined) {
    currentGoalsTests = goals;
    currentGoals =
    currentGoalsBins == undefined && currentGoalsTests == undefined ?
        undefined : [...currentGoalsBins??[], ...currentGoalsTests??[]];
    vscode.commands.executeCommand('setContext', "autotools:filterByTarget",
        (currentGoals && (currentGoals.length != 0)));
}


// Initialization from settings (or backup default rules).
// This is called at activation time (with activation boolean being passed as true explicitly)
// or after any change in the configuration/build-target workspace state variables, in which case
// we need a refresh of all settings expanding ${configuration} or ${buildTarget}.
export async function initFromSettings(activation: boolean = false, span: Span): Promise<void> {
    readLoggingLevel();
    await readMakePath();
    readtraceLiveTestRuns();
    readpromptClean();
    readautoreconfWarnCross();
    readautoreconfWarnObsolete();
    readautoreconfWarnPortability();
    readautoreconfWarnOverride();
    readautoreconfWarnGnu();
    readautoreconfWarnUnsupported();
    await readAutoreconfTool();
    readCppProvider();

    // await setCurrentMakefileConfiguration(currentMakefileConfigurationName);

    // FIXME: seems wrong to do || make.t_all; this fn should probably be called
    // config arg after config is fully loaded.
    // await extension._projectOutlineProvider.update(extension.getState().buildConfiguration); // FIXME: update with real target

    // Watch for Makefile Tools setting updates that can change the IntelliSense config provider dirty state.
    // More than one setting may be updated on one settings.json save,
    // so make sure to OR the dirty state when it's calculated by a formula (not a simple TRUE value).
    extension.extensionContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e : vscode.ConfigurationChangeEvent) => {
        if (!vscode.workspace.workspaceFolders)
            return;
        const keyRoot: string = "autotools";
        let span = telemetry.startSpan("uS", extension.journey);
        let updatedSettingsSubkeys: string[] = [];
        for (const folder of vscode.workspace.workspaceFolders) {
            if (!e.affectsConfiguration(keyRoot, folder))
                continue;
            let fc = configs.get(folder);
            if (!fc) {
                fc = new FolderConfig(folder);
                configs.set(folder, fc);
                await startFolders(span, [fc]);
                continue;
            }
            let c = vscode.workspace.getConfiguration(keyRoot, folder);
            // We are interested in updating only some relevant properties.
            // A subset of these should also trigger an IntelliSense config provider update.
            // Avoid unnecessary updates (for example, when settings are modified via the extension quickPick).
            let updatedTestEnvironments : boolean = false;
            let subKey: string;

/*
            subKey = "loggingLevel";
            let updatedLoggingLevel : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedLoggingLevel !== loggingLevel) {
                readLoggingLevel();
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
            }

            subKey = "makePath";
            let updatedMakePath : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedMakePath !== makePath) {
                // Not very likely, but it is safe to consider that a different make tool
                // may produce a different dry-run output with potential impact on IntelliSense,
                // so trigger an update (unless we read from a build log).
                extension.getState().configureDirty = true;
                await readMakePath();
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
            }
*/
            // Base tests environment XFAIL_TESTS is handled inside readGlobalTestEnvironment()
            subKey = "TESTS_ENVIRONMENT";
            let oldProjectTestEnvironment = fc.gTestEnvironment;
            let newC = c.get<EnvironmentSetting>(subKey);
            if (!util.areEqual(oldProjectTestEnvironment.TESTS_ENVIRONMENT, newC)) {
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
                updatedTestEnvironments = true;
            }
            subKey = "XFAIL_TESTS";
            newC = c.get<EnvironmentSetting>(subKey);
            if (!util.areEqual(oldProjectTestEnvironment.XFAIL_TESTS, newC)) {
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
                updatedTestEnvironments = true;
            }


            // Read and update test environments
            subKey = "test_environments";
            if (!updatedTestEnvironments) {
                let updatedEnvironments = await c.get<TestEnvironment[]>(subKey, []);
                updatedEnvironments && cleanupLoadedTestEnvironments(updatedEnvironments, fc.testEnvironments);
                updatedTestEnvironments = !util.areEqual(updatedEnvironments, fc.loadedTestEnvironments)
                if (updatedTestEnvironments)
                    updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
            }
            if (updatedTestEnvironments) {// Update the tasks with new environments
                fc.reloadTestEnvironments(c);
            }

            subKey = "configurations";
            let updatedMakefileConfigurations : MakefileConfiguration[] | undefined = c.get<MakefileConfiguration[]>(subKey);
            let updatedConfiguration: MakefileConfiguration | undefined = updatedMakefileConfigurations?.find(k => {
                if (k.name === fc!.config.name) {
                    return k;
                }
            });
            var needConfigure : boolean = !util.areEqual(updatedConfiguration?.configureArgs, fc.config.configureArgs);
            // TODO: should call an onConfigurationUpdate(updatedConfiguration);
            // so that not only build log, but other updated members can be handled
            var updatedMakeArgs : boolean = !util.areEqual(updatedConfiguration?.makeArgs, fc.config.makeArgs);
            if (updatedMakeArgs) {
                fc.config.makeArgs = updatedConfiguration?.makeArgs;
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}.makeArgs`);
            }
            if (needConfigure) {
                    fc.state.configureDirty = needConfigure;
                    fc.config.configureArgs = updatedConfiguration?.configureArgs;
                    updatedSettingsSubkeys.push(`${folder.index}.${subKey}.configureArgs`);
                    var configuring : Promise<boolean> = fc.configure(span);
                    if (promptClean) {
                        const cleanit: string = localize("autotools.cleanit", "Clean");
                        const setit: string = localize("autotools.edit.setting", "Setting...");

                        vscode.window.showWarningMessage(
                            localize("autotools.should.clean", "Does this change require 'make clean'?"),
                            cleanit, localize("autotools.no", "No"), setit)
                        .then((value) => {
                            if (value === cleanit) {
                                if (configuring)
                                    configuring.then<boolean>(() => true);
                                fc!.buildTasks.build(make.t_clean);
                            } else if (value === setit) {
                                openSettings("autotools.promptClean", folder, false);
                            }
                        });
                    }
                    if (configuring)
                        configuring.finally();
            }
/*
            subKey = "keepDryRuns";
            let updatedkeepDryRuns : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedkeepDryRuns !== keepDryRuns) {
                readkeepDryRuns();
                updatedSettingsSubkeys.push(`${folder.index}.${subKey}`);
            }

            subKey = "traceLiveTestRuns";
            let updatedtraceLiveTestRuns : boolean = util.getSettingOr<boolean>(subKey, false);
            let updatedTestTasks : boolean = (updatedtraceLiveTestRuns !== traceLiveTestRuns);
            if (updatedtraceLiveTestRuns !== traceLiveTestRuns) {
                readtraceLiveTestRuns();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }


            subKey = "keepConfigurationCache";
            let updatedkeepConfigurationCache : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedkeepConfigurationCache !== keepConfigurationCache) {
                readkeepConfigurationCache();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnCross";
            let updatedautoreconfWarnCross : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnCross !== autoreconfWarnCross) {
                readautoreconfWarnCross();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnPortability";
            let updatedautoreconfWarnPortability : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnPortability !== autoreconfWarnPortability) {
                readautoreconfWarnPortability();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnObsolete";
            let updatedautoreconfWarnObsolete : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnObsolete !== autoreconfWarnObsolete) {
                readautoreconfWarnObsolete();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnOverride";
            let updatedautoreconfWarnOverride : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnOverride !== autoreconfWarnOverride) {
                readautoreconfWarnOverride();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnGnu";
            let updatedautoreconfWarnGnu : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnGnu !== autoreconfWarnGnu) {
                readautoreconfWarnGnu();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfWarnUnsupported";
            let updatedautoreconfWarnUnsupported : boolean = util.getSettingOr<boolean>(subKey, true);
            if (updatedautoreconfWarnUnsupported !== autoreconfWarnUnsupported) {
                readautoreconfWarnUnsupported();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            subKey = "autoreconfTool";
            let updatedautoreconfTool : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedautoreconfTool !== autoreconfTool) {
                await readAutoreconfTool();
                updatedSettingsSubkeys.push(${folder.index}.${subKey});
            }

            // Final updates in some constructs that depend on more than one of the above settings.
            if (!extension.getState().configureDirty) {
                if (updatedTestEnvironments) {
                    updateEnvironmentsForTraits();
                    extension.resyncTasks();
                } else if (updatedTestTasks || updatedMakeArgs) {
                    extension.resyncTasks();
                }
            } else {
                if (await analyzeConfigureParams(span, true, false)) {
                    await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange, folder);
                }
            }

            // Report all the settings changes detected by now.
            // TODO: to avoid unnecessary telemetry processing, evaluate whether the changes done
            // in the object autotools.launchConfigurations and autotools.configurations
            // apply exactly to the current launch configuration, since we don't collect and aggregate
            // information from all the array yet.
            updatedSettingsSubkeys.forEach(async (subKey) => {
                let key: string = keyRoot + "." + subKey;
                logger.message(`${key} setting changed.`, "Verbose");
                try {
                    // For settings that use "." in their name, make sure we send the right object
                    // to the telemetry function. Currently, the schema for such a setting
                    // is represented differently than the workspace setting value.
                    let settingObj: any;
                    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(keyRoot, util.getConfigScope());
                    if (subKey.includes(".")) {
                       const subKeys: string[] = subKey.split(".");
                       settingObj = workspaceConfiguration;
                       subKeys.forEach(key => {
                          settingObj = settingObj[key];
                       });
                    } else {
                       settingObj = workspaceConfiguration[subKey];
                    }

                } catch (e) {
                    telemetry.logException(e, span);
                    logger.message(e.message);
                }
            });

*/
            if (fc.state.configureDirty) {
                await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange, fc);
            }
        }
        telemetry.endSpanWithStatus(span, SpanStatusCode.OK, undefined, {
            changed: updatedSettingsSubkeys.join(",")
        });

    }));
}

export async function selectFolderConfig() : Promise<FolderConfig> {
    if (configs.size == 1) {
        let [folder,fc] = configs.entries().next().value;
        return fc;
    }
    if (configs.size == 0)
        return Promise.reject("No folders in the workspace");
    let items = Array.from(configs.values())
        .filter(i => i.isAutotoolsProject)
        .map<PickItem>(i => new PickItem(i, i.folder.name));
    if (items.length == 1)
        return items[0].item;
    if (items.length == 0)
        return Promise.reject("No autotools projects in the workspace");
    let options: vscode.QuickPickOptions = {
        placeHolder: localize("autotools.selectFolder.placeholder", "Select a workspace folder"),
        title: localize("autotools.selectFolder.title", "Folder selection"),
        matchOnDescription: false,
        matchOnDetail: true
    };
    const chosen: PickItem | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen)
        return chosen.item;
    return Promise.reject("Aborted selection");
}

class PickItem implements vscode.QuickPickItem {

    constructor(public item: any | undefined, public label: string, public description?: string, public detail?: string) {
    }
    public kind?: vscode.QuickPickItemKind;
}
const editOrCreatePick : PickItem = new PickItem(undefined, localize("autotools.edit.setting", "New/Edit ..."));
export function prepareConfigurationsQuickPick(fc: FolderConfig): PickItem[] {
    const items: PickItem[] = fc.getBuildConfigs().map<PickItem>((k =>
        new PickItem(k, k.name, k.top_builddir, k.configureArgs ? "Args: " + k.configureArgs.join(" ") : undefined)
        ));

    if (items.length === 0) {
        logger.message("No configurations defined in autotools.configurations setting.");
        items.push(new PickItem(undefined, "Default", undefined, undefined));
    }

    items.push({item: undefined, label: 'Add/Edit...', kind: vscode.QuickPickItemKind.Separator}, editOrCreatePick);
    return items;
}

// Fill a drop-down with all the configuration names defined by the user in autotools.configurations setting.
// Triggers a cpptools configuration provider update after selection.
export async function setNewConfiguration(span: Span, fc: FolderConfig): Promise<void> {
    const items: PickItem[] = prepareConfigurationsQuickPick(fc);

    let options: vscode.QuickPickOptions = {
        placeHolder: localize("autotools.selectConfiguration", "Select a build configuration"),
        title: localize("autotools.selectConfiguration", "Build Configuration selection"),
        matchOnDescription: false,
        matchOnDetail: true
    };
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    const chosen: PickItem | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen && chosen.item !== fc.buildConfig) {
        let newC = telemetry.startSpan("newC", extension.journey);
        telemetry.logEvent(newC, "changeConfig", { to: chosen.label });

        if (chosen === editOrCreatePick) {
            await openSettings("autotools.configurations", fc.folder, false);
            return;
        }

        fc.state.buildConfiguration = (chosen.item as MakefileConfiguration).name;
        let newConfig = new FolderConfig(fc.folder);
        configs.set(fc.folder, newConfig);
        fc.dispose();

        await newConfig.start(newC);
        await newConfig.parseBuildConfig(newC, make.TriggeredBy.configureAfterConfigurationChange);
        newC.end();
    }
}


export function prepareEnvQuickPick(fc: FolderConfig): PickItem[] {
    const items: PickItem[] = fc.testEnvironments.map<PickItem>((k =>
        new PickItem(k, k.name, k.dirs ? (k.dirs.length ? "only in: " + k.dirs.join(", ") : "nowhere") : "", k.testExecOptions?.env?.TESTS_ENVIRONMENT || "no vars")
        ));

    if (items.length === 0) {
        logger.message("No configurations defined in autotools.configurations setting.");
        items.push(new PickItem(fc.testEnvironments[0], fc.testEnvironments[0].name, "all suites", JSON.stringify(fc.testEnvironments[0].TESTS_ENVIRONMENT)));
    }

    items.push({item: undefined, label: 'Add/Edit...', kind: vscode.QuickPickItemKind.Separator}, editOrCreatePick);
    return items;
}

// Fill a drop-down with all the configuration names defined by the user in autotools.configurations setting.
// Triggers a cpptools configuration provider update after selection.
export async function setNewEnvironment(fc: FolderConfig): Promise<void> {
    const items: PickItem[] = prepareEnvQuickPick(fc);

    let options: vscode.QuickPickOptions = {
        placeHolder: localize("autotools.selectTestEnvironment", "Select a test environment for {0}", fc.getProjectName()),
        title: localize("autotools.selectEnvironment", "Test Environment selection"),
        matchOnDescription: false,
        matchOnDetail: true
    };
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    const chosen: PickItem | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen && chosen.item !== fc.currentTestEnvironment) {

        if (chosen === editOrCreatePick) {
            telemetry.logEvent(extension.journey, "editCreateEnv");
            await openSettings("autotools.configurations", fc.folder, false);
            return;
        } else {
            telemetry.logEvent(extension.journey, "changeEnv", { to: chosen.label });
        }

        fc.currentTestEnvironmentName = chosen.item.name;
        extension._projectTestSuitesProvider.updateTargets(fc, true);
    }
}

function buildDirHash(c: MakefileConfiguration) : number {
    return parseInt(createHash('md5').update(
        (c.configureArgs?.join(',') ?? '')+`buildDir=${c.top_builddir}`
    ).digest('hex').slice(0,13), 16);
}
export function envHash(e: string) : number {
    return parseInt(createHash('md5').update(e).digest('hex').slice(0,13), 16);
}
// List of targets defined in the makefile project.
// Parsed from the build log, configuration cache or live dry-run output at configure time.
// Currently, this list contains any abstract intermediate target
// (like any object produced by the compiler from a source code file).
// TODO: filter only the relevant targets (binaries, libraries, etc...) from this list.
// let buildTargets: Map<string, Map<string,Goal>> = new Map();
// export function getAllBuildTargets(): Map<string, Map<string,Goal>> { return buildTargets; }
// export function clearTargets(): void { buildTargets = new Map(); }
