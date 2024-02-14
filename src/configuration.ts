// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Configuration support

import { extension, telemetry, statusBar } from './extension';
import { SpanStatusCode } from './tele';
import * as logger from './logger';
import * as make from './make';
import { Goal } from './parser/gnumake';
import * as ui from './ui';
import * as util from './util';
import * as vscode from 'vscode';
import * as path from 'path';
import { openSettings } from './extension';
import { createHash } from 'crypto';

import * as nls from 'vscode-nls';
import { BuildTask } from './tasks';
import { assert } from 'console';
import { quote } from '@mergesium/shell-quote';
import { Span } from '@opentelemetry/api';

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

export var traits : {
    overrides_TESTS_ENVIRONMENT: boolean;
    log_drivers: Set<string>;
} = {
    overrides_TESTS_ENVIRONMENT: false,
    log_drivers: new Set<string>()
};
export function clearTraits() {
    traits = {
        overrides_TESTS_ENVIRONMENT: false,
        log_drivers: new Set<string>()
    };
}
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

export function getFolder() : string {
    return vscode.workspace.workspaceFolders ?
        (vscode.workspace.workspaceFolders[0].name) : 'xx';
}
let currentMakefileConfigurationName: string | "Default";
export function setCurrentMakefileConfigurationName(configuration: string | undefined): void {
    currentMakefileConfigurationName = configuration || "Default";
}

// Last configuration name picked from the set defined in autotools.configurations setting.
// Saved into the workspace state. Also reflected in the configuration status bar button.
// If no particular current configuration is defined in settings, set to 'Default'.
let currentMakefileConfiguration: MakefileConfiguration;
export function getCurrentMakefileConfiguration(): MakefileConfiguration { return currentMakefileConfiguration; }
export async function setCurrentMakefileConfiguration(configuration: string | undefined, span: Span): Promise<void> {
    // Create a read-only file used to block autmake TEST_SUITE outputting summaries for indiv. tests.
    // Used in tasks.ts with
    let oldconfig = currentMakefileConfigurationName;
    let olddir = currentMakefileConfiguration?.top_builddir;
    currentMakefileConfiguration = (configuration && getMakefileConfiguration(configuration)) || {
        name: "Default",
        top_builddir: defaultBuildFolder(),
        isDefault: true,
    }
    statusBar.setConfiguration(currentMakefileConfiguration.name, currentMakefileConfiguration.top_builddir);
    if (configuration != oldconfig || currentMakefileConfiguration.top_builddir != olddir) {
        logger.message(`Selected build configuration is "${configuration}" in ${currentMakefileConfiguration.top_builddir}`);
    } else {
        logger.message(`Selected build configuration is "${configuration}" in ${currentMakefileConfiguration.top_builddir}`, 'Verbose');
    }
    if (testEnvironments.length) setBuildEnvPath();
    extension.onConfigurationSelect(currentMakefileConfiguration);
}

// Read the current configuration from workspace state, update status bar item
export function readCurrentMakefileConfiguration(): void {
    let buildConfiguration : string | undefined = extension.getState().buildConfiguration;
    setCurrentMakefileConfigurationName(buildConfiguration);
}

// Read the current configuration from workspace state, update status bar item
export function readCurrentTestEnvironment(): void {
    let state : string | undefined = extension.getState().testEnvironment;
    setCurrentTestEnvironmentName(state);
}

// The default make tool is "make"
let makePath: string = "make";
export function getMakePath(): string { return makePath; }
export function setMakePath(path: string | undefined): void { makePath = path || "make"; }

// Read the path (full or directory only) of the make tool if defined in settings.
// It represents a default to look for if no other path is already included
// in "autotools.configurations.makePath".
async function readMakePath(): Promise<void> {
    setMakePath(await util.getExpandedSetting<string>("makePath"));
}

let configureAc: string | undefined;
export function setConfigureAc(file : string | undefined): void {
    configureAc = file;
    vscode.commands.executeCommand('setContext', "autotools:haveManifest", file ? 1 : 2);
}
export function getConfigureAc(): string | undefined { return configureAc; }

let loggingLevel: string | undefined;
export function getLoggingLevel(): string | undefined { return loggingLevel; }
export function setLoggingLevel(logLevel: string): void { loggingLevel = logLevel; }

// Read from settings the desired logging level for the Makefile Tools extension.
export function readLoggingLevel(): void {
    loggingLevel = util.getSetting<string>("loggingLevel") || "Normal";
    logger.message(`Logging level: ${loggingLevel}`, "Verbose");
}

// The configuration cache is stored in ${top_builddir}/.vscode/all.cache
// Ie, each config is keyed to the configuration and target
// TODO: The user should have the option to turn off the cache because it may become decoherent with the
// workspace when the source is changed (eg, diff branch checked out) between vscode reloads.
export function getConfigurationCachePath(): string {
    let builddir = currentMakefileConfiguration.top_builddir || util.getWorkspaceRoot();
    if (!path.isAbsolute(builddir)) {
        builddir = util.resolvePathToRoot(builddir);
    }
    let cachePath: string = path.join(builddir, ".vscode");
    util.createDirectorySync(cachePath);
    return cachePath;
}

// Keep the dry-run output in the configuration directory?
//   true : file will be saved as ${top_builddir}/.vscode/all.dryrun.log
//   false: file will be not be saved
let keepDryRuns: boolean;
export function getKeepDryRuns(): boolean { return keepDryRuns; }
export function readkeepDryRuns() : void {
    keepDryRuns = util.getSettingOr<boolean>("keepDryRuns", false);
}

// Keep the configurationCache in the configuration directory?
//   true : file will be saved as ${top_builddir}/.vscode/all.cache,
//          and loaded at next reload, before dry-running
//   false: file will be not be saved
let keepConfigurationCache: boolean;
export function getKeepConfigurationCache(): boolean { return keepConfigurationCache; }
export function readkeepConfigurationCache() : void {
    keepConfigurationCache = util.getSettingOr<boolean>("keepConfigurationCache", false);
}

// prompt to clean when the active configuration changes?
//   true : prompt, clean if user confirms
//   false: no prompting, no cleaning
let promptClean: boolean;
export function getPromptClean(): boolean { return promptClean; }
export function readpromptClean() : void {
    promptClean = util.getSetting<boolean>("promptClean") || true;
}

let traceLiveTestRuns: boolean;
export function gettraceLiveTestRuns(): boolean { return traceLiveTestRuns; }
export function readtraceLiveTestRuns() : void {
    traceLiveTestRuns = util.getSettingOr<boolean>("traceLiveTestRuns", false);
}

let autoreconfWarnCross: boolean;
export function getautoreconfWarnCross(): boolean { return autoreconfWarnCross; }
export function readautoreconfWarnCross() : void {
    autoreconfWarnCross = util.getSettingOr<boolean>("autoreconfWarnCross", false);
}

let autoreconfWarnPortability: boolean;
export function getautoreconfWarnPortability(): boolean { return autoreconfWarnPortability; }
export function readautoreconfWarnPortability() : void {
    autoreconfWarnPortability = util.getSettingOr<boolean>("autoreconfWarnPortability", false);
}

let autoreconfWarnObsolete: boolean;
export function getautoreconfWarnObsolete(): boolean { return autoreconfWarnObsolete; }
export function readautoreconfWarnObsolete() : void {
    autoreconfWarnObsolete = util.getSettingOr<boolean>("autoreconfWarnObsolete", false);
}

let autoreconfWarnOverride: boolean;
export function getautoreconfWarnOverride(): boolean { return autoreconfWarnOverride; }
export function readautoreconfWarnOverride() : void {
    autoreconfWarnOverride = util.getSettingOr<boolean>("autoreconfWarnOverride", false);
}

let autoreconfWarnUnsupported: boolean;
export function getautoreconfWarnUnsupported(): boolean { return autoreconfWarnUnsupported; }
export function readautoreconfWarnUnsupported() : void {
    autoreconfWarnUnsupported = util.getSettingOr<boolean>("autoreconfWarnUnsupported", true);
}

let autoreconfWarnGnu: boolean;
export function getautoreconfWarnGnu(): boolean { return autoreconfWarnGnu; }
export function readautoreconfWarnGnu() : void {
    autoreconfWarnGnu = util.getSettingOr<boolean>("autoreconfWarnGnu", false);
}

let autoreconfTool: string = 'autoreconf';
export function getAutoreconfTool(): string { return autoreconfTool; }
export async function readAutoreconfTool() : Promise<void> {
    autoreconfTool = await util.getExpandedSetting<string>("autoreconfTool") || 'autoreconf';
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


// The following (makefile, problem matchers, build log), same as command&args above
// are deduced via a set of rules of defaults and overrides that we calculate only when necessary
// and access the last result otherwise.
// configurationMakefile is detected as the "Makefile" or "makefile" in the top_builddir
let configurationMakefile: string | undefined;
export function getConfigurationMakefile(): string | undefined { return configurationMakefile; }
export function setConfigurationMakefile(makefilePath: string | undefined): void { configurationMakefile = makefilePath; }


// the topMakefile is the GNUMakefile or Makefile which would be used when running "make"
// This can be different than the ConfigurationMakefile (automake output, always Makefile)
let topMakefile: string | undefined;
export function gettopMakefile(): string | undefined { return topMakefile; }
export function settopMakefile(makefilePath: string | undefined): void { topMakefile = makefilePath; }

let configurationProblemMatchers: string[] = [];
export function getConfigurationProblemMatchers(): string[] { return configurationProblemMatchers; }
export function setConfigurationProblemMatchers(problemMatchers: string[]): void { configurationProblemMatchers = problemMatchers; }

export function accountForTraits(): void {
    if (traits.overrides_TESTS_ENVIRONMENT) {
        logger.message(`WARNING: The ${extension.pkginfo?.name} package overrides test environment settings. Disabling environments.`, 'Normal');
        logger.message(`KB: ${extension.kbUrlStatic.toString(true)}#overrides-test-environments`, 'Normal');
    }
    updateEnvironmentsForTraits();
}
// Analyze the settings of the current makefile configuration and the global workspace settings,
// according to various merging rules and decide what make command and build log
// apply to the current makefile configuration.
export let initialConfigurationAttempted : boolean = false;
export async function analyzeConfigureParams(parentSpan: Span, reload: boolean, failIfUnconfigured : boolean): Promise<boolean> {
    let result : string;
    let hasMakefile : boolean = false;
    let span = telemetry.startSpan("an", parentSpan);

    extension.getState().configureDirty = false;

    /* If there is no configuration, this will redetect the default build directory
     * Otherwise, it's a noop.
     */
    await setCurrentMakefileConfiguration(currentMakefileConfigurationName, span);

    let isAutotools = extension.isAutotoolsProject();
    let bootstrapped = isAutotools && extension.isBootstrapped();
    let configured = bootstrapped && extension.isConfigured();
    // If initially not configured, an attempt is made to bootstrap and configure.
    // This flag avoids the normal make.configure() call at the end of activate()
    // proj is configured already at activation
    initialConfigurationAttempted ||= !configured && !failIfUnconfigured;
    vscode.commands.executeCommand("setContext", "autotools:isBootstrapped", bootstrapped ? 1 : 2);

    if (isAutotools) {
        if (bootstrapped) {
            if (configured || (!failIfUnconfigured && await extension.configure(span))) {
                let relativeMakefile = findMakefile();
                if (!reload) {
                    let kbUrl = await extension.kbUrl();
                    if (relativeMakefile) {
                        extension._projectOutlineProvider.update(currentMakefileConfigurationName);
                        extension.createPanel();
                        await logMakeCmd(relativeMakefile);
                        extension.setConfiguration(currentMakefileConfigurationName);
                        vscode.commands.executeCommand("setContext", "autotools:hasTargets", 2);
                        extension._projectOutlineProvider?.clear();
                        extension._projectTestSuitesProvider?.clear();
                                        // extension.setConfiguration(currentMakefileConfigurationName);
                        result = "ok";
                        hasMakefile = true;
                    } else {
                        logger.message('Configuration succeeded but there is no makefile.');
                        logger.message('KB: ' + kbUrl.toString(true) + '#no-makefile-found', "Normal");
                        /* Override the bootstrapped context so the welcome button "Bootstrap is shown" */
                        vscode.commands.executeCommand("setContext", "autotools:isBootstrapped", 2);
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
            statusBar.setStatus(extension.isAutotoolsProject() ?
                (hasMakefile ? ui.UIStatus.OK : ui.UIStatus.NO_MAKEFILE) :
                ui.UIStatus.NON_AUTOTOOLS);
    } else {
        result = "n/a";
    }

    telemetry.logEvent(span, "analyze", { result: result });
    span.end();
    getProblemMatchersForConfiguration();
    return Promise.resolve(hasMakefile);
}

function getMakefileConfiguration(configuration: string): MakefileConfiguration | undefined {
   return makefileConfigurations.find(k => {
      if (k.name === configuration) {
          return k;
      }
  });
}

function defaultBuildFolder(): string {
    let config_status = util.resolvePathToRoot("config.status");
    return util.checkFileExistsSync(config_status) ? '' : 'build/Default';
}

function findMakefile(): string | undefined {
    // top_builddir is resolved to either a subdirectory of the workspace or an absolute path.
    let abs_top_builddir: string = util.resolvePathToRoot(currentMakefileConfiguration.top_builddir);

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
    extension.updateMakefileFilePresent(makefileExists);
    if (!makefileExists)
        relativeMakefile = topMakefile;
    settopMakefile(topMakefile);
    setConfigurationMakefile(relativeMakefile);

    return relativeMakefile;
}

export async function logMakeCmd(relativeMakefile: string): Promise<void> {
    if (currentMakefileConfiguration.makeArgs)
        logger.message(`Make cmd (${relativeMakefile}): '${makePath} ${currentMakefileConfiguration.makeArgs.join(" ")}' for configuration "${currentMakefileConfiguration.name}"`, "Debug");
    else
        logger.message(`Make cmd (${relativeMakefile}): '${makePath}' for configuration "${currentMakefileConfiguration.name}"`, "Verbose");
}

// Helper to find in the array of MakefileConfiguration which problemMatchers correspond to a configuration name
export function getProblemMatchersForConfiguration(): void {
    configurationProblemMatchers = currentMakefileConfiguration.problemMatchers || [];
}

let makefileConfigurations: MakefileConfiguration[] = [];
export function getMakefileConfigurations(): MakefileConfiguration[] { return makefileConfigurations; }
export function setMakefileConfigurations(configurations: MakefileConfiguration[]): void { makefileConfigurations = configurations; }

// Read make configurations optionally defined by the user in settings: makefile.configurations.
export async function readMakefileConfigurations(currentConfigurationName : string, span: Span): Promise<void> {
    // We need to read "makefile.configurations" unexpanded first, because we may write back into these settings
    // in case we indentify "name" missing. We'll expand later, see end of function.
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
    makefileConfigurations = workspaceConfiguration.get<MakefileConfiguration[]>("configurations") || [];
    let detectedUnnamedConfigurations: boolean = false;
    let unnamedConfigurationId: number = 0;

    vscode.commands.executeCommand('setContext', "autotools:haveConfigurations",
        makefileConfigurations.length ? 1 : 2);

    // Collect unnamed configurations (probably) defined by the extension earlier,
    // to make sure we avoid duplicates in case any new configuration is in need of a name.
    let unnamedConfigurationNames: string [] = makefileConfigurations.map((k => {
        return k.name;
    }));
    unnamedConfigurationNames = unnamedConfigurationNames.filter(item => (item && item.startsWith("Unnamed configuration")));

    makefileConfigurations.forEach(element => {
        if (!element.name) {
            detectedUnnamedConfigurations = true;

            // Just considering the possibility that there are already unnamed configurations
            // defined with IDs other than the rule we assume (like not consecutive numbers, but not only).
            // This may happen when the user deletes configurations at some point without updating the IDs.
            unnamedConfigurationId++;
            let autoGeneratedName: string = `Unnamed configuration ${unnamedConfigurationId}`;
            while (unnamedConfigurationNames.includes(autoGeneratedName)) {
                unnamedConfigurationId++;
                autoGeneratedName = `Unnamed configuration ${unnamedConfigurationId}`;
            }

            element.name = autoGeneratedName;
            logger.message(`Defining name ${autoGeneratedName} for unnamed configuration ${element}.`);
        }
    });

    // Log the updated list of configuration names
    const makefileConfigurationNames: string[] = makefileConfigurations.map((k => {
        return k.name;
    }));
    if (makefileConfigurationNames.length > 0) {
        logger.message("Defined autotools.configurations: " + makefileConfigurationNames.join(";"), "Verbose");
    }

    // Verify if the current makefile configuration (check against the expanded values)
    // is still part of the list and unset otherwise.
    // Exception: "Default" which means the user didn't set it and relies on whatever default
    // the current set of makefiles support. "Default" is not going to be part of the list
    // but we shouldn't log about it.
    if (currentConfigurationName && currentConfigurationName !== "Default" && !makefileConfigurationNames.includes(currentConfigurationName)) {
        logger.message(`Current makefile configuration ${currentConfigurationName} is no longer present in the available list.` +
            ` Re-setting the current makefile configuration to default.`);
        await setConfigurationByName(undefined, span);
    }
}

let testEnvironments: TestEnvironment[] = [];
export function getTestEnvironments(): TestEnvironment[] {
    return testEnvironments; }

let loadedTestEnvironments: TestEnvironment[] = [];
export function getLoadedEnvironments(): TestEnvironment[] { return loadedTestEnvironments; }

//export function setMakefileConfigurations(configurations: MakefileConfiguration[]): void { makefileConfigurations = configurations; }

// Read make configurations optionally defined by the user in settings: makefile.configurations.
export async function readTestEnvironments(): Promise<void> {
    // We need to read "makefile.configurations" unexpanded first, because we may write back into these settings
    // in case we indentify "name" missing. We'll expand later, see end of function.
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
    loadedTestEnvironments = [nullTestEnvironment(),...(workspaceConfiguration.get<TestEnvironment[]>("test_environments") || [])];
    let unnamedConfigurationId: number = 0;

    vscode.commands.executeCommand('setContext', "autotools:haveEnvironments",
        loadedTestEnvironments.length ? 1 : 2);

    const unnamedPrefix = "Unnamed";
    // Collect unnamed configurations (probably) defined by the extension earlier,
    // to make sure we avoid duplicates in case any new configuration is in need of a name.
    let unnamedConfigurationNames: string [] = testEnvironments.map((k => {
        return k.name || unnamedPrefix;
    }));
    unnamedConfigurationNames = unnamedConfigurationNames.filter(item => (item && item.startsWith("Unnamed")));

    loadedTestEnvironments.forEach(element => {
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
            logger.message(`Defining name ${autoGeneratedName} for unnamed test environment ${element}.`);
        }
    });

    // Log the updated list of configuration names
    const testEnvironmentNames: string[] = testEnvironments.map((k => {
        return k.name;
    }));
    if (testEnvironmentNames.length > 0) {
        logger.message("Defined autotools.test_environments: " + testEnvironmentNames.join(";"), "Verbose");
    }
}

function updateEnvironmentsForTraits(): void {
    if (traits.overrides_TESTS_ENVIRONMENT) {
        let e: TestEnvironment = nullTestEnvironment();
        e.testExecOptions = processExecutionOptions(e);
        e.checkExecOptions = processExecutionOptions(e);
        e.updateExecOptions = processExecutionOptions(e);
        e.testDebugEnv = processDebugEnvironment(e);
        e.XFAIL_TESTS = gTestEnvironment.XFAIL_TESTS??[];
        testEnvironments = [e];
    } else {
        var global_XFAIL_TESTS = gTestEnvironment.XFAIL_TESTS??[];
        testEnvironments = [];
        loadedTestEnvironments.forEach(element => {
            let e: TestEnvironment = {
                name: element.name,
                /* Need separate ExecOptions for test and check commands because test run with SUBDIRS env in updateEnvironmentsForCurrentMakefile() */
                testExecOptions: processExecutionOptions(element),
                checkExecOptions: processExecutionOptions(element),
                updateExecOptions: processExecutionOptions(element),
                testDebugEnv: processDebugEnvironment(element),
                hashCode: 0,
                XFAIL_TESTS: element.XFAIL_TESTS ? [...global_XFAIL_TESTS,...element.XFAIL_TESTS??[]] : global_XFAIL_TESTS};
                if (element.dirs)
                    e.dirs = element.dirs;
                e.hashCode = envHash(e.testExecOptions?.env?.TESTS_ENVIRONMENT ?? '')
                testEnvironments.push(e);
        });
    }
    traits.log_drivers.forEach(d => {
        testEnvironments.forEach(e => {
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
    })
    let newName = setCurrentTestEnvironment(currentTestEnvironmentName);
    setBuildEnvPath();
    extension.setTestEnvironmentName(newName);
}

function processExecutionOptions(env: TestEnvironment) : vscode.ProcessExecutionOptions {
    if (traits.overrides_TESTS_ENVIRONMENT) {
        return { env: {
            MAKEFLAGS: "-I " + extension.rulesPath,
            LOG_DRIVER: extension.testRunner
        } };
    }
    var vars : string[] = [];
    if (gTestEnvironment.TESTS_ENVIRONMENT)
        Object.entries(gTestEnvironment.TESTS_ENVIRONMENT).forEach(([name,value]) => {
            name &&
                vars.push(`${name}=` + quote([`${value}`]));
        });
    if (env.TESTS_ENVIRONMENT)
        Object.entries(env.TESTS_ENVIRONMENT).forEach(([name,value]) => {
            name &&
                vars.push(`${name}=` + quote([`${value}`]));
        });
    return { env: { TESTS_ENVIRONMENT: vars.join(' '),
        MAKEFLAGS: "-I " + extension.rulesPath,
        LOG_DRIVER: extension.testRunner
    } };
}
function processDebugEnvironment(env: TestEnvironment) : { [key: string]: string } {
    var vars : EnvironmentSetting = {};
    if (traits.overrides_TESTS_ENVIRONMENT)
        return vars;
    if (gTestEnvironment.TESTS_ENVIRONMENT)
        Object.entries(gTestEnvironment.TESTS_ENVIRONMENT).forEach(([name,value]) => {
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

export function getTestEnvironment(name: string) : TestEnvironment {
    return testEnvironments.find(k => k.name === name) || testEnvironments[0];
}

let currentTestEnvironmentName : string;
function setCurrentTestEnvironmentName(name : string | undefined) {
    currentTestEnvironmentName = name ?? nullTestEnvironment().name;
}
let currentTestEnvironment : TestEnvironment;
export function getCurrentTestEnvironment() : TestEnvironment {
    return currentTestEnvironment;
}
function setCurrentTestEnvironment(name: string | undefined) : string {
    let newEnv = (name ? testEnvironments.find(e =>
            e.name == name
    ) : undefined);
    currentTestEnvironment = newEnv ?? testEnvironments[0];
    return currentTestEnvironment.name;
}

let buildEnvPath : string = '';
function setBuildEnvPath() : void {
    buildEnvPath = `/${getCurrentTestEnvironment().hashCode.toString(36)}/${buildDirHash(currentMakefileConfiguration).toString(36)}`;
}
export function getBuildEnvPath() : string {
    return buildEnvPath;
}

let buildEnvPath : string = '';
function setBuildEnvPath() : void {
    buildEnvPath = `/${getCurrentTestEnvironment().hashCode.toString(36)}/${buildDirHash(currentMakefileConfiguration).toString(36)}`;
}
export function getBuildEnvPath() : string {
    return buildEnvPath;
}

function nullTestEnvironment() : TestEnvironment {
        return {
            name: "<null>",
            TESTS_ENVIRONMENT: {},
            hashCode: envHash('')}
}

let gTestEnvironment : TestEnvironment = {
    name: "global",
    TESTS_ENVIRONMENT: {},
    hashCode: -1
};
export async function readGlobalTestEnvironment(): Promise<void> {
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
    gTestEnvironment.TESTS_ENVIRONMENT = workspaceConfiguration.get<EnvironmentSetting>("TESTS_ENVIRONMENT") ||
        {};

    gTestEnvironment.XFAIL_TESTS = workspaceConfiguration.get<string[]>("XFAIL_TESTS") || [];

    vscode.commands.executeCommand('setContext', "autotools:haveGlobalWaivers",
        gTestEnvironment.XFAIL_TESTS?.length ? 1 : 2);

    if (gTestEnvironment.XFAIL_TESTS && gTestEnvironment.XFAIL_TESTS.length > 0) {
        logger.message("Defined autotools.XFAIL_TESTS: " + gTestEnvironment.XFAIL_TESTS.join(";"), "Verbose");
    }
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

// The current target is the read from the default built task,
// or the first Linked_binary target
export async function getCurrentTarget(): Promise<make.BuildTarget> {
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
        return Promise.resolve(definition.target);
    }

    // If no default build task, return the make target that is a linked binary
    for (const[dir, targets] of buildTargets) {
        for (let [name, goal] of targets) {
            if (goal.flags & Goal.Flags.Linked_binary) {
                assert(goal.task, "Current target goal should have task(s)", goal);
                if (goal.task instanceof vscode.Task)
                    return Promise.resolve(goal.task.definition.target);
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

// Initialization from the state of the workspace.
// The user does not have direct access to this data.
// The extension sets state variables via user actions like:
// set configuration, set build target, set launch target.
// At activation time we read from state, update UI accordingly
// and commands become available to be run in settings via expansion.
export function initFromState(): void {
   readCurrentMakefileConfiguration();
   readCurrentTestEnvironment();
}

// Initialization from settings (or backup default rules).
// This is called at activation time (with activation boolean being passed as true explicitly)
// or after any change in the configuration/build-target workspace state variables, in which case
// we need a refresh of all settings expanding ${configuration} or ${buildTarget}.
export async function initFromSettings(activation: boolean = false, span: Span): Promise<void> {
    readLoggingLevel();
    await readMakePath();
    readkeepDryRuns();
    readkeepConfigurationCache();
    readtraceLiveTestRuns();
    readpromptClean();
    readautoreconfWarnCross();
    readautoreconfWarnObsolete();
    readautoreconfWarnPortability();
    readautoreconfWarnOverride();
    readautoreconfWarnGnu();
    readautoreconfWarnUnsupported();
    await readAutoreconfTool();
    await readGlobalTestEnvironment();
    await readMakefileConfigurations(currentMakefileConfigurationName, span);
    await readTestEnvironments();
    // await setCurrentMakefileConfiguration(currentMakefileConfigurationName);

    // FIXME: seems wrong to do || make.t_all; this fn should probably be called
    // config arg after config is fully loaded.
    // await extension._projectOutlineProvider.update(extension.getState().buildConfiguration); // FIXME: update with real target

    // Watch for Makefile Tools setting updates that can change the IntelliSense config provider dirty state.
    // More than one setting may be updated on one settings.json save,
    // so make sure to OR the dirty state when it's calculated by a formula (not a simple TRUE value).
    vscode.workspace.onDidChangeConfiguration(async e => {
        if (vscode.workspace.workspaceFolders && e.affectsConfiguration('autotools')) {
            // We are interested in updating only some relevant properties.
            // A subset of these should also trigger an IntelliSense config provider update.
            // Avoid unnecessary updates (for example, when settings are modified via the extension quickPick).
            let updatedTestEnvironments : boolean = false;
            let updatedSettingsSubkeys: string[] = [];
            const keyRoot: string = "autotools";
            let subKey: string;

            let span = telemetry.startSpan("uS", extension.journey);
            subKey = "loggingLevel";
            let updatedLoggingLevel : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedLoggingLevel !== loggingLevel) {
                readLoggingLevel();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "makePath";
            let updatedMakePath : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedMakePath !== makePath) {
                // Not very likely, but it is safe to consider that a different make tool
                // may produce a different dry-run output with potential impact on IntelliSense,
                // so trigger an update (unless we read from a build log).
                extension.getState().configureDirty = true;
                await readMakePath();
                updatedSettingsSubkeys.push(subKey);
            }

            // Base tests environment XFAIL_TESTS is handled inside readGlobalTestEnvironment()
            subKey = "TESTS_ENVIRONMENT";
            let oldProjectTestEnvironment = gTestEnvironment;
            await readGlobalTestEnvironment();
            if (!util.areEqual(oldProjectTestEnvironment, gTestEnvironment)) {
                updatedSettingsSubkeys.push(subKey);
                updatedTestEnvironments = true;
            }

            // Read and update test environments
            subKey = "test_environments";
            if (!updatedTestEnvironments) {
                let updatedEnvironments = await util.getExpandedSetting<TestEnvironment[]>(subKey);
                updatedTestEnvironments = !util.areEqual(updatedEnvironments, getLoadedEnvironments())
            }
            if (updatedTestEnvironments) {
                await readTestEnvironments();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "configurations";
            let updatedMakefileConfigurations : MakefileConfiguration[] | undefined = await util.getExpandedSetting<MakefileConfiguration[]>(subKey);
            let updatedConfiguration: MakefileConfiguration | undefined = updatedMakefileConfigurations?.find(k => {
                if (k.name === currentMakefileConfiguration.name) {
                    return k;
                }
            });
            if (!util.areEqual(updatedMakefileConfigurations, makefileConfigurations)) {
                await readMakefileConfigurations(currentMakefileConfigurationName, span);
                //await setCurrentMakefileConfiguration(currentMakefileConfigurationName);
            }
            // TODO: should call an onConfigurationUpdate(updatedConfiguration);
            // so that not only build log, but other updated members can be handled
            var needConfigure : boolean = false;
            if (updatedConfiguration) {
//                updatedConfiguration.nologs = currentMakefileConfiguration.nologs;
                var oldConfig = currentMakefileConfiguration;
                if (!util.areEqual(updatedConfiguration, oldConfig)) {
                    needConfigure = !util.areEqual(
                            updatedConfiguration?.configureArgs,
                            oldConfig.configureArgs);
                    extension.getState().configureDirty = true;

                    await setCurrentMakefileConfiguration(currentMakefileConfigurationName, span);
                    var configuring : Promise<boolean> | undefined;
                    if (needConfigure) {
                        configuring = extension.configure(span);
                    }

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
                                extension.build(make.t_clean);
                            } else if (value === setit) {
                                openSettings("autotools.promptClean");
                            }
                        });
                    }
                    if (configuring)
                        configuring.finally();
                }
            } else if (updatedTestEnvironments) // Update the tasks with new environments
                extension.onConfigurationSelect(currentMakefileConfiguration);


            subKey = "keepDryRuns";
            let updatedkeepDryRuns : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedkeepDryRuns !== keepDryRuns) {
                readkeepDryRuns();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "traceLiveTestRuns";
            let updatedtraceLiveTestRuns : boolean = util.getSettingOr<boolean>(subKey, false);
            let updatedTestTasks : boolean = (updatedtraceLiveTestRuns !== traceLiveTestRuns);
            if (updatedtraceLiveTestRuns !== traceLiveTestRuns) {
                readtraceLiveTestRuns();
                updatedSettingsSubkeys.push(subKey);
            }


            subKey = "keepConfigurationCache";
            let updatedkeepConfigurationCache : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedkeepConfigurationCache !== keepConfigurationCache) {
                readkeepConfigurationCache();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnCross";
            let updatedautoreconfWarnCross : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnCross !== autoreconfWarnCross) {
                readautoreconfWarnCross();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnPortability";
            let updatedautoreconfWarnPortability : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnPortability !== autoreconfWarnPortability) {
                readautoreconfWarnPortability();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnObsolete";
            let updatedautoreconfWarnObsolete : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnObsolete !== autoreconfWarnObsolete) {
                readautoreconfWarnObsolete();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnOverride";
            let updatedautoreconfWarnOverride : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnOverride !== autoreconfWarnOverride) {
                readautoreconfWarnOverride();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnGnu";
            let updatedautoreconfWarnGnu : boolean = util.getSettingOr<boolean>(subKey, false);
            if (updatedautoreconfWarnGnu !== autoreconfWarnGnu) {
                readautoreconfWarnGnu();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfWarnUnsupported";
            let updatedautoreconfWarnUnsupported : boolean = util.getSettingOr<boolean>(subKey, true);
            if (updatedautoreconfWarnUnsupported !== autoreconfWarnUnsupported) {
                readautoreconfWarnUnsupported();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "autoreconfTool";
            let updatedautoreconfTool : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedautoreconfTool !== autoreconfTool) {
                await readAutoreconfTool();
                updatedSettingsSubkeys.push(subKey);
            }

            // Final updates in some constructs that depend on more than one of the above settings.
            if (!extension.getState().configureDirty) {
                if (updatedTestEnvironments) {
                    updateEnvironmentsForTraits();
                    extension.resyncTasks();
                } else if (updatedTestTasks) {
                    extension.resyncTasks();
                }
            } else
                await analyzeConfigureParams(span, true, false);

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
                    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(keyRoot);
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

            if (extension.getState().configureDirty) {
                await make.configure(span, make.TriggeredBy.configureAfterConfigurationChange);
            }
            telemetry.endSpanWithStatus(span, SpanStatusCode.OK, undefined, {
                changed: updatedSettingsSubkeys.join(",")
            });
        }
    });
}

export async function setConfigurationByName(configurationName: string | undefined, span: Span): Promise<void> {
    setCurrentMakefileConfigurationName(configurationName);
    extension.getState().buildConfiguration = configurationName;
    logger.message(`Setting configuration - ${currentMakefileConfigurationName}`);
    // Refresh settings, they may reference variables or commands reading state configuration var (${configuration}).
    await initFromSettings(true, span);
    await analyzeConfigureParams(span, false, false);
    extension._projectOutlineProvider.update(currentMakefileConfigurationName);
}

class PickItem implements vscode.QuickPickItem {

    constructor(public item: any | undefined, public label: string, public description?: string, public detail?: string) {
    }
    public kind?: vscode.QuickPickItemKind;
}
const editOrCreatePick : PickItem = new PickItem(undefined, localize("autotools.edit.setting", "New/Edit ..."));
export function prepareConfigurationsQuickPick(): PickItem[] {
    const items: PickItem[] = makefileConfigurations.map<PickItem>((k =>
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
export async function setNewConfiguration(span: Span): Promise<void> {
    const items: PickItem[] = prepareConfigurationsQuickPick();

    let options: vscode.QuickPickOptions = {
        placeHolder: localize("autotools.selectConfiguration", "Select a build configuration"),
        title: localize("autotools.selectConfiguration", "Build Configuration selection"),
        matchOnDescription: false,
        matchOnDetail: true
    };
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    const chosen: PickItem | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen && chosen.label !== currentMakefileConfiguration.name) {
        let newC = telemetry.startSpan("newC", extension.journey);
        telemetry.logEvent(newC, "changeConfig", { to: chosen.label });

        if (chosen === editOrCreatePick) {
            await openSettings("autotools.configurations");
            return;
        }

        await setConfigurationByName(chosen.label, span);

        await make.configure(newC, make.TriggeredBy.configureAfterConfigurationChange);
        newC.end();
    }
}


export function prepareEnvQuickPick(): PickItem[] {
    const items: PickItem[] = testEnvironments.map<PickItem>((k =>
        new PickItem(k, k.name, k.dirs ? k.dirs.join(", ") : "all suites", k.testExecOptions?.env?.TESTS_ENVIRONMENT || "no vars")
        ));

    if (items.length === 0) {
        logger.message("No configurations defined in autotools.configurations setting.");
        items.push(new PickItem(testEnvironments[0], testEnvironments[0].name, "all suites", JSON.stringify(testEnvironments[0].TESTS_ENVIRONMENT)));
    }

    items.push({item: undefined, label: 'Add/Edit...', kind: vscode.QuickPickItemKind.Separator}, editOrCreatePick);
    return items;
}

// Fill a drop-down with all the configuration names defined by the user in autotools.configurations setting.
// Triggers a cpptools configuration provider update after selection.
export async function setNewEnvironment(): Promise<void> {
    const items: PickItem[] = prepareEnvQuickPick();

    let options: vscode.QuickPickOptions = {
        placeHolder: localize("autotools.selectTestEnvironment", "Select a test environment"),
        title: localize("autotools.selectEnvironment", "Test Environment selection"),
        matchOnDescription: false,
        matchOnDetail: true
    };
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    const chosen: PickItem | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen && chosen.item !== getCurrentTestEnvironment()) {

        if (chosen === editOrCreatePick) {
            telemetry.logEvent(extension.journey, "editCreateEnv");
            await openSettings("autotools.configurations");
            return;
        } else {
            telemetry.logEvent(extension.journey, "changeEnv", { to: chosen.label });
        }

        let newName = setCurrentTestEnvironment(chosen.item.name);
        setBuildEnvPath();
        extension.getState().testEnvironment = newName;
        extension.setTestEnvironmentName(newName);
        extension._projectTestSuitesProvider.updateTree();
    }
}

function buildDirHash(c: MakefileConfiguration) : number {
    return parseInt(createHash('md5').update(
        (c.configureArgs?.join(',') ?? '')+`buildDir=${c.top_builddir}`
    ).digest('hex').slice(0,13), 16);
}
function envHash(e: string) : number {
    return parseInt(createHash('md5').update(e).digest('hex').slice(0,13), 16);
}
// List of targets defined in the makefile project.
// Parsed from the build log, configuration cache or live dry-run output at configure time.
// Currently, this list contains any abstract intermediate target
// (like any object produced by the compiler from a source code file).
// TODO: filter only the relevant targets (binaries, libraries, etc...) from this list.
let buildTargets: Map<string, Map<string,Goal>> = new Map();
export function getAllBuildTargets(): Map<string, Map<string,Goal>> { return buildTargets; }
