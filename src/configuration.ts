// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Configuration support

import {extension} from './extension';
import * as logger from './logger';
import * as make from './make';
import { BuildTarget } from './make';
import { Goal } from './parser/gnumake';
import * as ui from './ui';
import * as util from './util';
import * as vscode from 'vscode';
import * as path from 'path';
import * as telemetry from './telemetry';
import * as multiStep from './multiStepInput';
import { openSettings } from './extension';
import * as fs from 'fs';

import * as nls from 'vscode-nls';
import { dir } from 'console';
import { Disposable } from 'vscode-jsonrpc';
import { AutoToolsBuildTaskProvider, BuildTask } from './tasks';
import assert = require('assert');
import { fstat } from 'fs';
import G = require('glob');
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

let statusBar: ui.UI = ui.getUI();

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
    top_builddir?: string;

    // options used in the build invocation
    // don't use more than one argument in a string
    makeArgs?: string[];

    // list of problem matcher names to be used when building the current target
    problemMatchers?: string[];

    // is this a default configuration?
    isDefault: boolean;

    // unwriteable file used to block autmake TEST_SUITE outputting summaries for indiv. tests
    nolog: vscode.ProcessExecutionOptions;

    // TODO: investigate how flexible this is to integrate with other build systems than the MAKE family
    // (basically anything that can produce a dry-run output is sufficient)
    // Implement set-able dry-run, verbose, change-directory and always-make switches
    // since different tools may use different arguments for the same behavior
}

let currentMakefileConfigurationName: string | "Default";
export async function setCurrentMakefileConfigurationName(configuration: string | undefined): Promise<void> {
    currentMakefileConfigurationName = configuration || "Default";
}

// Last configuration name picked from the set defined in autotools.configurations setting.
// Saved into the workspace state. Also reflected in the configuration status bar button.
// If no particular current configuration is defined in settings, set to 'Default'.
let currentMakefileConfiguration: MakefileConfiguration;
export function getCurrentMakefileConfiguration(): MakefileConfiguration { return currentMakefileConfiguration; }
export async function setCurrentMakefileConfiguration(configuration: string | undefined): Promise<void> {
    // Create a read-only file used to block autmake TEST_SUITE outputting summaries for indiv. tests.
    // Used in tasks.ts with
    currentMakefileConfiguration = (configuration && getMakefileConfiguration(configuration)) || {
        name: "Default",
        top_builddir: (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].name : ""),
        isDefault: true,
        nolog: {}
    }
    let nolog_file = path.join(currentMakefileConfiguration.top_builddir??'',"no-partial-suite-log");
    let tmp = nolog_file + '.tmp';
    try {
        fs.stat(tmp, (err) => {
            if (err?.code === 'ENOENT') {
                fs.createWriteStream(tmp, {flags: 'w'})
                .on('close', () => fs.chmodSync(tmp, "0444"))
                .close();
            }
        });
    } catch (err) {
        // Ignore. If chmod failed, the summary will be printed when single tests are run.
        // Ugly, but no reason to alarm the user.
    }
    currentMakefileConfiguration.nolog ={
        // These options are static, and not relevant to the end-user. Avoid displaying them to the user
        env: {
            // FIXME: generate a proper tmpfile with extension .tmp and make it
            // readonly, This prevents the test suite summary being printed.
            "TEST_SUITE_LOG": nolog_file,
            "SUBDIRS": "",
            // Suppress bash's error message "/bin/bash: line 74: /tmp/tmp-suite-log.tmp: Permission denied" to stderr
            "am__sh_e_setup": 'set +e; exec 2> /dev/null'
    }};
    statusBar.setConfiguration(currentMakefileConfiguration.name);
}

// Read the current configuration from workspace state, update status bar item
export function readCurrentMakefileConfiguration(): void {
    let buildConfiguration : string | undefined = extension.getState().buildConfiguration;
    if (!buildConfiguration) {
        logger.message("No build configuration is selected. Assuming 'Default'.");
    } else {
        logger.message(`Selected build configuration is "${buildConfiguration}"`);
    }
    setCurrentMakefileConfigurationName(buildConfiguration);
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
}
export function getConfigureAc(): string | undefined { return configureAc; }

let loggingLevel: string | undefined;
export function getLoggingLevel(): string | undefined { return loggingLevel; }
export function setLoggingLevel(logLevel: string): void { loggingLevel = logLevel; }

// Read from settings the desired logging level for the Makefile Tools extension.
export async function readLoggingLevel(): Promise<void> {
    loggingLevel = await util.getExpandedSetting<string>("loggingLevel") || "Normal";
    logger.message(`Logging level: ${loggingLevel}`);
}

let extensionLog: string | undefined;
export function getExtensionLog(): string | undefined { return extensionLog; }
export function setExtensionLog(path: string): void { extensionLog = path; }

// Read from settings the path to a log file capturing all the "Makefile Tools" output channel content.
// Useful for very large repos, which would produce with a single command a log larger
// than the "Makefile Tools" output channel capacity.
// Also useful for developing unit tests based on real world code,
// that would not clone a whole repo for testing.
// If an extension log is specified, its content is cleared during activation.
// Any messages that are being logged throughout the lifetime of the extension
// are going to be appended to this file.
export async function readExtensionLog(): Promise<void> {
    extensionLog = await util.getExpandedSetting<string>("extensionLog");
    if (extensionLog) {
        extensionLog = util.resolvePathToRoot(extensionLog);

        logger.message(`Writing extension log at ${extensionLog}`);
    }
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
export async function readkeepDryRuns() : Promise<void> {
    keepDryRuns = await util.getExpandedSetting<boolean>("keepDryRuns") || false;
}

// Keep the configurationCache in the configuration directory?
//   true : file will be saved as ${top_builddir}/.vscode/all.cache,
//          and loaded at next reload, before dry-running
//   false: file will be not be saved
let keepConfigurationCache: boolean;
export function getKeepConfigurationCache(): boolean { return keepConfigurationCache; }
export async function readkeepConfigurationCache() : Promise<void> {
    keepConfigurationCache = await util.getExpandedSetting<boolean>("keepConfigurationCache") || false;
}

// The following (makefile, problem matchers, build log), same as command&args above
// are deduced via a set of rules of defaults and overrides that we calculate only when necessary
// and access the last result otherwise.
// configurationMakefile is detected as the "Makefile" or "makefile" in the top_builddir
let configurationMakefile: string | undefined;
export function getConfigurationMakefile(): string | undefined { return configurationMakefile; }
export function setConfigurationMakefile(makefilePath: string | undefined): void { configurationMakefile = makefilePath; }

let configurationProblemMatchers: string[] = [];
export function getConfigurationProblemMatchers(): string[] { return configurationProblemMatchers; }
export function setConfigurationProblemMatchers(problemMatchers: string[]): void { configurationProblemMatchers = problemMatchers; }

// Analyze the settings of the current makefile configuration and the global workspace settings,
// according to various merging rules and decide what make command and build log
// apply to the current makefile configuration.
async function analyzeConfigureParams(): Promise<void> {
    await getCommandForConfiguration();
    getProblemMatchersForConfiguration();
}

function getMakefileConfiguration(configuration: string): MakefileConfiguration | undefined {
   return makefileConfigurations.find(k => {
      if (k.name === configuration) {
          return k;
      }
  });
}

// Helper to find in the array of MakefileConfiguration which command/args correspond to a configuration name.
// Higher level settings (like autotools.makePath, autotools.configurations.top_builddir)
// also have an additional effect on the final command.
export async function getCommandForConfiguration(): Promise<void> {
    // top_builddir is resolved to either a subdirectory of the workspace or an absolute path.
    let abs_top_builddir: string = util.resolvePathToRoot(currentMakefileConfiguration.top_builddir || "");

    // The make file is in top_builddir
    // and is named "Makefile" or "makefile" or "GNUmakefile".
    let makeFileTest: string | undefined;
    // filename of makefile relative to top_builddir
    let relativeMakefile: string | undefined;
    let makefileExists : boolean = false;
    relativeMakefile = "GNUmakefile";
    makeFileTest = path.join(abs_top_builddir, relativeMakefile);
    makefileExists = util.checkFileExistsSync(makeFileTest);
    if (!makefileExists) {
        relativeMakefile = "Makefile";
        makeFileTest = path.join(abs_top_builddir, relativeMakefile);
        makefileExists = util.checkFileExistsSync(makeFileTest);
    }
    if (!makefileExists) {
        relativeMakefile = "makefile";
        makeFileTest = path.join(abs_top_builddir, relativeMakefile);
        makefileExists = util.checkFileExistsSync(makeFileTest);
    }

    // if we found the makefile add it to command line to ensure make has the same understanding
    // of which makefile is the correct one.
    // TODO: If the installed make _is_ GNU, then GNUmakefile should be prefered. Need to detect if
    // make is GNU or not.
    if (makefileExists) {
        configurationMakefile = relativeMakefile;
        if (currentMakefileConfiguration.makeArgs)
            logger.message(`Deduced command '${makePath} ${currentMakefileConfiguration.makeArgs.join(" ")}' for configuration "${currentMakefileConfiguration.name}"`);
        else
            logger.message(`Deduced command '${makePath}' for configuration "${currentMakefileConfiguration.name}"`);
    } else {
        logger.message(`A makefile was not found for configuration "${currentMakefileConfiguration.name}"`);
    }
    // store the found makefile for display in the outline
    setConfigurationMakefile(makefileExists ? relativeMakefile : undefined);
    extension.updateMakefileFilePresent(makefileExists);
    statusBar.setStatus(makefileExists ? ui.UIStatus.OK : ui.UIStatus.NO_MAKEFILE);

    // Validation and warnings about properly defining the makefile and make tool.
    if (!makefileExists) {
        logger.message("The makefile entry point was not found. " +
            "Make sure it exists at the location defined by " +
            "autotools.configurations[].top_builddir");

        // we may need more advanced ability to process settings
        // insight into different project structures
        const telemetryProperties: telemetry.Properties = {
            reason: "no Makefile"
        };

        telemetry.logEvent("makefileNotFound", telemetryProperties);
        await extension.setFullFeatureSet(false);
        statusBar.setLoading(ui.UIStatus.NO_MAKEFILE);
    } else {
        await extension.setFullFeatureSet(true);
    }
}

// Helper to find in the array of MakefileConfiguration which problemMatchers correspond to a configuration name
export function getProblemMatchersForConfiguration(): void {
    configurationProblemMatchers = currentMakefileConfiguration.problemMatchers || [];
}

let makefileConfigurations: MakefileConfiguration[] = [];
export function getMakefileConfigurations(): MakefileConfiguration[] { return makefileConfigurations; }
export function setMakefileConfigurations(configurations: MakefileConfiguration[]): void { makefileConfigurations = configurations; }

// Read make configurations optionally defined by the user in settings: makefile.configurations.
export async function readMakefileConfigurations(currentConfigurationName : string): Promise<void> {
    // We need to read "makefile.configurations" unexpanded first, because we may write back into these settings
    // in case we indentify "name" missing. We'll expand later, see end of function.
    let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
    makefileConfigurations = workspaceConfiguration.get<MakefileConfiguration[]>("configurations") || [];
    let detectedUnnamedConfigurations: boolean = false;
    let unnamedConfigurationId: number = 0;

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

    if (detectedUnnamedConfigurations) {
        logger.message("Updating makefile configurations in settings.");
        await workspaceConfiguration.update("configurations", makefileConfigurations);
    }

    // Now read "makefile.configurations" again and expand as needed.
    makefileConfigurations = await util.getExpandedSetting<MakefileConfiguration[]>("configurations") || [];

    // Log the updated list of configuration names
    const makefileConfigurationNames: string[] = makefileConfigurations.map((k => {
        return k.name;
    }));
    if (makefileConfigurationNames.length > 0) {
        logger.message("Found the following configurations defined in autotools.configurations setting: " + makefileConfigurationNames.join(";"));
    }

    // Verify if the current makefile configuration (check against the expanded values)
    // is still part of the list and unset otherwise.
    // Exception: "Default" which means the user didn't set it and relies on whatever default
    // the current set of makefiles support. "Default" is not going to be part of the list
    // but we shouldn't log about it.
    if (currentConfigurationName !== "Default" && !makefileConfigurationNames.includes(currentConfigurationName)) {
        logger.message(`Current makefile configuration ${currentConfigurationName} is no longer present in the available list.` +
            ` Re-setting the current makefile configuration to default.`);
        await setConfigurationByName(undefined);
    }
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
        assert(definition && definition.target);
        return Promise.resolve(definition.target);
    }

    // If no default build task, return the make target that is a linked binary
    for (const[dir, targets] of buildTargets) {
        for (let [name, goal] of targets) {
            if (goal.flags & Goal.Flags.Linked_binary) {
                assert(goal.task);
                return Promise.resolve(goal.task.definition.target);
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
// These can also be resetted via the makefile.resetState command.
export function initFromState(): void {
   readCurrentMakefileConfiguration();
}

// Initialization from settings (or backup default rules).
// This is called at activation time (with activation boolean being passed as true explicitly)
// or after any change in the configuration/build-target workspace state variables, in which case
// we need a refresh of all settings expanding ${configuration} or ${buildTarget}.
export async function initFromSettings(activation: boolean = false): Promise<void> {
    // Read first anything related to the extension log,
    // to be able to document any upcoming reads.
    await readExtensionLog();

    // Delete the extension log file, if exists, even if we lose what we logged earlier
    // about reading the output folder and extension log.
    // The deletion should happen only at activation time (to not allow the log file to grow indefinitely),
    // while reading the settings is done at activation time  and also anytime later,
    // after changing a makefile configuration, a build or a launch target.
    let extensionLog : string | undefined = getExtensionLog();
    if (extensionLog && activation && util.checkFileExistsSync(extensionLog)) {
        util.deleteFileSync(extensionLog);
    }

    await readLoggingLevel();
    await readMakePath();
    await readkeepDryRuns();
    await readkeepConfigurationCache();
    await readMakefileConfigurations(currentMakefileConfigurationName);

    setCurrentMakefileConfiguration(currentMakefileConfigurationName);
    await analyzeConfigureParams();

    // FIXME: seems wrong to do || make.t_all; this fn should probably be called
    // config arg after config is fully loaded.
    // await extension._projectOutlineProvider.update(extension.getState().buildConfiguration); // FIXME: update with real target

    // Modifying any makefile should trigger an IntelliSense config provider update,
    // so make the dirty state true.
    // TODO: limit to makefiles relevant to this project, instead of any random makefile anywhere.
    //       We can't listen only to the makefile pointed to autotools.configurations.top_builddir,
    //       because that is only the entry point and can refer to other relevant makefiles.
    // TODO: don't trigger an update for any dummy save, verify how the content changed.
    vscode.workspace.onDidSaveTextDocument(e => {
        if (e.uri.fsPath.toLowerCase().endsWith("makefile")) {
            extension.getState().configureDirty = true;
        }
    });

    // Watch for Makefile Tools setting updates that can change the IntelliSense config provider dirty state.
    // More than one setting may be updated on one settings.json save,
    // so make sure to OR the dirty state when it's calculated by a formula (not a simple TRUE value).
    vscode.workspace.onDidChangeConfiguration(async e => {
        if (vscode.workspace.workspaceFolders && e.affectsConfiguration('autotools')) {
            // We are interested in updating only some relevant properties.
            // A subset of these should also trigger an IntelliSense config provider update.
            // Avoid unnecessary updates (for example, when settings are modified via the extension quickPick).
            let telemetryProperties: telemetry.Properties | null = {};
            let updatedSettingsSubkeys: string[] = [];
            const keyRoot: string = "autotools";
            let subKey: string;

            subKey = "loggingLevel";
            let updatedLoggingLevel : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedLoggingLevel !== loggingLevel) {
                await readLoggingLevel();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "extensionLog";
            let updatedExtensionLog : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedExtensionLog) {
                updatedExtensionLog = util.resolvePathToRoot(updatedExtensionLog);
            }
            if (updatedExtensionLog !== extensionLog) {
                // No IntelliSense update needed.
                await readExtensionLog();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "makePath";
            let updatedMakePath : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedMakePath !== makePath) {
                // Not very likely, but it is safe to consider that a different make tool
                // may produce a different dry-run output with potential impact on IntelliSense,
                // so trigger an update (unless we read from a build log).
                extension.getState().configureDirty = extension.getState().configureDirty;
                await readMakePath();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "configurations";
            let updatedMakefileConfigurations : MakefileConfiguration[] | undefined = await util.getExpandedSetting<MakefileConfiguration[]>(subKey);
            if (!util.areEqual(updatedMakefileConfigurations, makefileConfigurations)) {
                // todo: skip over updating the IntelliSense configuration provider if the current makefile configuration
                // is not among the subobjects that suffered modifications.
                extension.getState().configureDirty = true;
                updatedSettingsSubkeys.push(subKey);
                let updatedConfiguration: MakefileConfiguration | undefined = updatedMakefileConfigurations?.find(k => {
                    if (k.name === currentMakefileConfiguration.name) {
                        return k;
                    }
                });
                // TODO: should call an onConfigurationUpdate(updatedConfiguration);
                // so that not only build log, but other updated members can be handled
                await readMakefileConfigurations(currentMakefileConfigurationName);
                if (!util.areEqual(updatedConfiguration, currentMakefileConfiguration)) {
                    setCurrentMakefileConfiguration(currentMakefileConfiguration.name);
                    extension.getState().configureDirty = true;

                    const cleanit: string = localize("autotools.cleanit", "Clean");
                    const setit: string = localize("autotools.edit.setting", "Setting...");
                    vscode.window.showWarningMessage(
                        localize("autotools.should.clean", "Does this change require 'make clean'?"),
                        cleanit, localize("autotools.no", "No"), setit)
                    .then((value) => {
                        if (value === cleanit) {
                            extension.build(make.t_clean);
                        } else if (value === setit) {
                            openSettings("autotools.promptClean");
                        }
                    });
                }
            }

            subKey = "keepDryRuns";
            let updatedkeepDryRuns : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedkeepDryRuns !== keepDryRuns) {
                await readkeepDryRuns();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "keepConfigurationCache";
            let updatedkeepConfigurationCache : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedkeepConfigurationCache !== keepConfigurationCache) {
                await readkeepConfigurationCache();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "additionalCompilerNames";
            let updatedAdditionalCompilerNames : string[] | undefined = await util.getExpandedSetting<string[]>(subKey);
            if (!util.areEqual(updatedAdditionalCompilerNames, additionalCompilerNames)) {
                await readAdditionalCompilerNames();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "excludeCompilerNames";
            let updatedExcludeCompilerNames : string[] | undefined = await util.getExpandedSetting<string[]>(subKey);
            if (!util.areEqual(updatedExcludeCompilerNames, excludeCompilerNames)) {
                await readExcludeCompilerNames();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "ignoreDirectoryCommands";
            let updatedIgnoreDirectoryCommands : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedIgnoreDirectoryCommands !== ignoreDirectoryCommands) {
                await readIgnoreDirectoryCommands();
                updatedSettingsSubkeys.push(subKey);
            }

            // Final updates in some constructs that depend on more than one of the above settings.
            await analyzeConfigureParams();

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

                    telemetryProperties = await telemetry.analyzeSettings(settingObj, key,
                        util.thisExtensionPackage().contributes.configuration.properties[key],
                        false, telemetryProperties);
                } catch (e) {
                    logger.message(e.message);
                }
            });
            if (extension.getState().configureDirty) {
                await make.configure(make.TriggeredBy.configureAfterConfigurationChange);
            }
            if (telemetryProperties && util.hasProperties(telemetryProperties)) {
                telemetry.logEvent("settingsChanged", telemetryProperties);
            }
        }
    });
}

export async function setConfigurationByName(configurationName: string | undefined): Promise<void> {
    setCurrentMakefileConfigurationName(configurationName);
    extension.getState().buildConfiguration = configurationName;
    logger.message(`Setting configuration - ${currentMakefileConfigurationName}`);
    logger.message("Re-reading settings after configuration change.");
    // Refresh settings, they may reference variables or commands reading state configuration var (${configuration}).
    await initFromSettings();
    extension._projectOutlineProvider.updateConfiguration(currentMakefileConfigurationName);
}

export function prepareConfigurationsQuickPick(): string[] {
    const items: string[] = makefileConfigurations.map((k => {
        return k.name;
    }));

    if (items.length === 0) {
        logger.message("No configurations defined in autotools.configurations setting.");
        items.push("Default");
    }

    return items;
}

// Fill a drop-down with all the configuration names defined by the user in autotools.configurations setting.
// Triggers a cpptools configuration provider update after selection.
export async function setNewConfiguration(): Promise<void> {
    const items: string[] = prepareConfigurationsQuickPick();

    let options: vscode.QuickPickOptions = {};
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    const chosen: string | undefined = await vscode.window.showQuickPick(items, options);
    if (chosen && chosen !== currentMakefileConfiguration.name) {
        let telemetryProperties: telemetry.Properties | null = {
            state: "makefileConfiguration"
        };
        telemetry.logEvent("stateChanged", telemetryProperties);

        await setConfigurationByName(chosen);

        await make.configure(make.TriggeredBy.configureAfterConfigurationChange);

        // Refresh telemetry for this new makefile configuration
        // (this will find the corresponding item in the autotools.configurations array
        // and report all the relevant settings of that object).
        // Because of this, the event name is still "settingsChanged", even if
        // we're doing a state change now.
        let keyRoot: string = "autotools";
        let subKey: string = "configurations";
        let key: string = keyRoot + "." + subKey;
        let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(keyRoot);
        telemetryProperties = {};

        // We should have at least one item in the configurations array
        // if the extension changes state for launch configuration,
        // but guard just in case.
        let makefileonfigurationSetting: any = workspaceConfiguration[subKey];
        if (makefileonfigurationSetting) {
            try {
                telemetryProperties = await telemetry.analyzeSettings(makefileonfigurationSetting, key,
                    util.thisExtensionPackage().contributes.configuration.properties[key],
                    true, telemetryProperties);
            } catch (e) {
                logger.message(e.message);
            }

            if (telemetryProperties && util.hasProperties(telemetryProperties)) {
                telemetry.logEvent("settingsChanged", telemetryProperties);
            }
        }
    }
}

// List of targets defined in the makefile project.
// Parsed from the build log, configuration cache or live dry-run output at configure time.
// Currently, this list contains any abstract intermediate target
// (like any object produced by the compiler from a source code file).
// TODO: filter only the relevant targets (binaries, libraries, etc...) from this list.
let buildTargets: Map<string, Map<string,Goal>> = new Map();
export function setBuildTargets(targets: Map<string, Map<string,Goal>>): void { buildTargets = targets; }
export function getAllBuildTargets(): Map<string, Map<string,Goal>> { return buildTargets; }
