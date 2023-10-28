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

import * as nls from 'vscode-nls';
import { dir } from 'console';
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
    makeDirectory?: string;

    // options used in the build invocation
    // don't use more than one argument in a string
    makeArgs?: string[];

    // list of problem matcher names to be used when building the current target
    problemMatchers?: string[];

    // is this a default configuration?
    isDefault: boolean;

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
    currentMakefileConfiguration = (configuration && getMakefileConfiguration(configuration)) || {
        name: "Default",
        makeDirectory: makeDirectory,
        isDefault: true
    };
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

// as described in autotools.panel.visibility
type MakefilePanelVisibility = {
    debug: boolean;
    run: boolean;
};

// internal, runtime representation of an optional feature
type MakefilePanelVisibilityDescription = {
    propertyName: string;
    default: boolean;
    value: boolean;
    enablement?: string;
};

// To add an optional feature (one that can be enabled/disabled based
// on a property stored in settings.json):
// * define property under autotools.panel.visibility in package.json
// * initialize here the default values
// * if the feature controls the UI via enablement,
// *    make sure enablement is handled in package.json, you are done
// * if not, then add code to check Feature state wherever is needed.
class MakefilePanelVisibilityDescriptions {
    features: MakefilePanelVisibilityDescription[] = [
        { propertyName: "debug", enablement: "autotools:localDebugFeature", default: true, value: false },
        { propertyName: "run", enablement: "autotools:localRunFeature", default: true, value: false }
    ];
}

let panelVisibility: MakefilePanelVisibilityDescriptions = new MakefilePanelVisibilityDescriptions();

// Set all features to their defaults (enabled or disabled)
function initOptionalFeatures(): void {
    for (let feature of panelVisibility.features) {
        feature.value = feature.default;
    }
}
export function isOptionalFeatureEnabled(propertyName: string): boolean {
    for (let feature of panelVisibility.features) {
        if (feature.propertyName === propertyName) {
            return feature.value;
        }
    }
    return false;
}

// Override default settings for each feature based on workspace current information
async function updateOptionalFeaturesWithWorkspace(): Promise<void> {
    // optionalFeatures will be set with default values.
    // override with values from the workspace
    let features: MakefilePanelVisibility | undefined = await util.getExpandedSetting<MakefilePanelVisibility>("panel.visibility") || undefined;
    if (features) {
        if (Object.entries(features).length < panelVisibility.features.length) {
            // At least one feature is missing from the settings, which means we need to use defaults.
            // If we don't refresh defaults here, we won't cover the following scenario:
            //    - default TRUE feature
            //    - which was set to false in the settings, causing knownFeature.value to be false
            //    - just got removed from settings now, meaning it won't be included in the features varibale and the FOR won't loop through it
            //    giving it no opportunity to switch .value back to the default of TRUE.
            initOptionalFeatures();
        }
        for (let propEntry of Object.entries(features)) {
            for (let knownFeature of panelVisibility.features) {
                if (propEntry[0] === knownFeature.propertyName) {
                    knownFeature.value = propEntry[1];
                }
            }
        }
    } else {
        initOptionalFeatures(); // no info in workspace, use defaults
    }
}

export function disableAllOptionallyVisibleCommands(): void {
    for (let feature of panelVisibility.features) {
        if (feature.enablement) {
            vscode.commands.executeCommand('setContext', feature.enablement, false);
        }
    }

}

function enableOptionallyVisibleCommands(): void {
    for (let feature of panelVisibility.features) {
        if (feature.enablement) {
            vscode.commands.executeCommand('setContext', feature.enablement, feature.value);
        }
    }
}
async function readFeaturesVisibility(): Promise<void> {
    await updateOptionalFeaturesWithWorkspace();
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

let makeDirectory: string | undefined;
export function getMakeDirectory(): string | undefined { return makeDirectory; }
export function setMakeDirectory(dir: string = ''): void { makeDirectory = dir; }
// Read the make working directory path if defined in settings.
// It represents a default to look for if no other makeDirectory is already provided
// in autotools.configurations.makeDirectory.
// TODO: validate and integrate with "-C [DIR_PATH]" passed in autotools.configurations.makeArgs.
async function readMakeDirectory(): Promise<void> {
    let makeDirectorySetting: string | undefined = await util.getExpandedSetting<string>("makeDirectory");
    if (!makeDirectorySetting) {
        logger.message("No folder path to the makefile is defined in the settings file.");
        setMakeDirectory();
    } else {
        setMakeDirectory(makeDirectorySetting);
    }
}

// Command property accessible from launch.json:
// the folder in which the current "make" invocation operates:
// passed with -C (otherwise it is the workspace folder).
// Note: -f does not change the current working directory. It only points to a makefile somewhere else.
export function makeBaseDirectory(): string {
    // In case more than one -C arguments are given to "make", it will chose the last one.
    // getConfigurationMakeArgs will contain the final command we calculate for the "make" executable.
    // We don't need to know here which -C gets pushed last (global makeDirectory,
    // configuration local makeDirectory or one in makeArgs). Just reverse to easily get the last one.
    const makeArgs: string[] = getConfigurationMakeArgs().concat().reverse();
    let prevArg: string = "";
    for (const arg of makeArgs) {
       if (arg === "-C") {
         return prevArg;
       } else if (arg.startsWith("--directory")) {
         const eqIdx: number = arg.indexOf("=");
         return arg.substring(eqIdx + 1, arg.length);
       }

       // Since we reversed the "make" command line arguments, the path of a -C will be seen before the switch.
       // Remember every previous argument to have it available in case we find the first -C.
       prevArg = arg;
    }

    return util.getWorkspaceRoot();
}

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

let preConfigureScript: string | undefined;
export function getPreConfigureScript(): string | undefined { return preConfigureScript; }
export function setPreConfigureScript(path: string): void { preConfigureScript = path; }

let postConfigureScript: string | undefined;
export function getPostConfigureScript(): string | undefined { return postConfigureScript; }
export function setPostConfigureScript(path: string): void { postConfigureScript = path; }

// Read from settings the path to a script file that needs to have been run at least once
// before a sucessful configure of this project.
export async function readPreConfigureScript(): Promise<void> {
    preConfigureScript = await util.getExpandedSetting<string>("preConfigureScript");
    if (preConfigureScript) {
        preConfigureScript = util.resolvePathToRoot(preConfigureScript);
        logger.message(`Found pre-configure script defined as ${preConfigureScript}`);
        if (!util.checkFileExistsSync(preConfigureScript)) {
            logger.message("Pre-configure script not found on disk.");
        }
    }
}

export async function readPostConfigureScript(): Promise<void> {
    postConfigureScript = await util.getExpandedSetting<string>("postConfigureScript");
    if (postConfigureScript) {
        postConfigureScript = util.resolvePathToRoot(postConfigureScript);
        logger.message(`Found post-configure script defined as ${postConfigureScript}`);
        if (!util.checkFileExistsSync(postConfigureScript)) {
            logger.message("Post-configure script not found on disk");
        }
    }
}

let alwaysPreConfigure: boolean | undefined;
export function getAlwaysPreConfigure(): boolean | undefined { return alwaysPreConfigure; }
export function setAlwaysPreConfigure(path: boolean): void { alwaysPreConfigure = path; }

let alwaysPostConfigure: boolean | undefined;
export function getAlwaysPostConfigure(): boolean | undefined { return alwaysPostConfigure; }
export function setAlwaysPostConfigure(path: boolean): void { alwaysPostConfigure = path; }

// Read from settings whether the pre-configure step is supposed to be executed
// always before the configure operation.
export async function readAlwaysPreConfigure(): Promise<void> {
    alwaysPreConfigure = await util.getExpandedSetting<boolean>("alwaysPreConfigure");
    logger.message(`Always pre-configure: ${alwaysPreConfigure}`);
}

export async function readAlwaysPostConfigure(): Promise<void> {
    alwaysPostConfigure = await util.getExpandedSetting<boolean>("alwaysPostConfigure");
    logger.message(`Always post-configure: ${alwaysPostConfigure}`);
}

// The configuration cache is stored in ${makeDirectory}/.vscode/${currentTarget}.cache
// Ie, each config is keyed to the configuration and target
// TODO: The user should have the option to turn off the cache because it may become decoherent with the
// workspace when the source is changed (eg, diff branch checked out) between vscode reloads.
export function getConfigurationCachePath(): string {
    let builddir = currentMakefileConfiguration.makeDirectory || getCurrentTarget().dir;
    if (!path.isAbsolute(builddir)) {
        builddir = util.resolvePathToRoot(builddir);
    }
    let cachePath: string = path.join(builddir, ".vscode");
    util.createDirectorySync(cachePath);
    return cachePath;
}

let compileCommandsPath: string | undefined;
export function getCompileCommandsPath(): string | undefined { return compileCommandsPath; }
export function setCompileCommandsPath(path: string): void { compileCommandsPath = path; }
export async function readCompileCommandsPath(): Promise<void> {
    compileCommandsPath = await util.getExpandedSetting<string>("compileCommandsPath");
    if (compileCommandsPath) {
        compileCommandsPath = util.resolvePathToRoot(compileCommandsPath);
    }

    logger.message(`compile_commands.json path: ${compileCommandsPath}`);
}

let additionalCompilerNames: string[] | undefined;
export function getAdditionalCompilerNames(): string[] | undefined { return additionalCompilerNames; }
export function setAdditionalCompilerNames(compilerNames: string[]): void { additionalCompilerNames = compilerNames; }
export async function readAdditionalCompilerNames(): Promise<void> {
    additionalCompilerNames = await util.getExpandedSetting<string[]>("additionalCompilerNames");
    if (additionalCompilerNames && additionalCompilerNames.length > 0) {
        logger.message(`Additional compiler names: '${additionalCompilerNames?.join("', '")}'`);
    }
}

let excludeCompilerNames: string[] | undefined;
export function getExcludeCompilerNames(): string[] | undefined { return excludeCompilerNames; }
export function setExcludeCompilerNames(compilerNames: string[]): void { excludeCompilerNames = compilerNames; }
export async function readExcludeCompilerNames(): Promise<void> {
    excludeCompilerNames = await util.getExpandedSetting<string[]>("excludeCompilerNames");
    if (excludeCompilerNames && excludeCompilerNames.length > 0) {
        logger.message(`Exclude compiler names: '${excludeCompilerNames?.join("', '")}'`);
    }
}

// Keep the dry-run output in the configuration directory?
//   true : file will be saved as ${makeDirectory}/.vscode/${currentTarget}.dryrun.log
//   false: file will be not be saved
let keepDryRuns: boolean;
export function getKeepDryRuns(): boolean { return keepDryRuns; }
export async function readkeepDryRuns() : Promise<void> {
    keepDryRuns = await util.getExpandedSetting<boolean>("keepDryRuns") || false;
}

// Keep the configurationCache in the configuration directory?
//   true : file will be saved as ${makeDirectory}/.vscode/${currentTarget}.cache,
//          and loaded at next reload, before dry-running
//   false: file will be not be saved
let keepConfigurationCache: boolean;
export function getKeepConfigurationCache(): boolean { return keepConfigurationCache; }
export async function readkeepConfigurationCache() : Promise<void> {
    keepConfigurationCache = await util.getExpandedSetting<boolean>("keepConfigurationCache") || false;
}

// Currently, the makefile extension supports debugging only an executable.
// TODO: Parse for symbol search paths
// TODO: support dll debugging.
export interface LaunchConfiguration {
    // The following properties constitute a minimal launch configuration object.
    // They all can be deduced from the dry-run output or build log.
    // When the user is selecting a launch configuration, the extension is verifying
    // whether there is an entry in the launch configurations array in settings
    // and if not, it is generating a new one with the values computed by the parser.
    binaryPath: string; // full path to the binary that this launch configuration is tied to
    binaryArgs: string[]; // arguments that this binary is called with for this launch configuration
    cwd: string; // folder from where the binary is run

    // The following represent optional properties that can be additionally defined by the user in settings.
    MIMode?: string;
    miDebuggerPath?: string;
    stopAtEntry?: boolean;
    symbolSearchPath?: string;
}

let launchConfigurations: LaunchConfiguration[] = [];
export function getLaunchConfigurations(): LaunchConfiguration[] { return launchConfigurations; }
export function setLaunchConfigurations(configurations: LaunchConfiguration[]): void { launchConfigurations = configurations; }

// Read launch configurations defined by the user in settings: autotools.launchConfigurations[]
async function readLaunchConfigurations(): Promise<void> {
   launchConfigurations = await util.getExpandedSetting<LaunchConfiguration[]>("launchConfigurations") || [];
}

// Helper used to fill the launch configurations quick pick.
// The input object for this method is either read from the settings or it is an object
// constructed by the parser while analyzing the dry-run output (or the build log),
// when the extension is trying to determine if and how (from what folder, with what arguments)
// the makefile is invoking any of the programs that are built by the current target.
// Properties other than cwd, binary path and args could be manually defined by the user
// in settings (after the extension creates a first minimal launch configuration object) and are not relevant
// for the strings being used to populate the quick pick.
// Syntax:
//    [CWD path]>[binaryPath]([binaryArg1,binaryArg2,binaryArg3,...])
export function launchConfigurationToString(configuration: LaunchConfiguration): string {
    let binPath: string = util.makeRelPath(configuration.binaryPath, configuration.cwd);
    let binArgs: string = configuration.binaryArgs.join(",");
    return `${configuration.cwd}>${binPath}(${binArgs})`;
}

// Helper used to construct a minimal launch configuration object
// (only cwd, binary path and arguments) from a string that respects
// the syntax of its quick pick.
export async function stringToLaunchConfiguration(str: string): Promise<LaunchConfiguration | undefined> {
    let regexp: RegExp = /(.*)\>(.*)\((.*)\)/mg;
    let match: RegExpExecArray | null = regexp.exec(str);

    if (match) {
        let fullPath: string = await util.makeFullPath(match[2], match[1]);
        let splitArgs: string[] = (match[3] === "") ? [] : match[3].split(",");

        return {
            cwd: match[1],
            binaryPath: fullPath,
            binaryArgs: splitArgs
        };
    } else {
        return undefined;
    }
}

let currentLaunchConfiguration: LaunchConfiguration | undefined;
export function getCurrentLaunchConfiguration(): LaunchConfiguration | undefined { return currentLaunchConfiguration; }
export async function setCurrentLaunchConfiguration(configuration: LaunchConfiguration | undefined): Promise<void> {
    currentLaunchConfiguration = configuration;
    let launchConfigStr: string = currentLaunchConfiguration ? launchConfigurationToString(currentLaunchConfiguration) : "";
    statusBar.setLaunchConfiguration(launchConfigStr);
    await extension._projectOutlineProvider.updateLaunchTarget(launchConfigStr);
}

function getLaunchConfiguration(name: string): LaunchConfiguration | undefined {
    return launchConfigurations.find(k => {
        if (launchConfigurationToString(k) === name) {
            return { ...k, keep: true };
        }
    });
}

// Construct the current launch configuration object:
// Read the identifier from workspace state storage, then find the corresponding object
// in the launch configurations array from settings.
// Also update the status bar item.
async function readCurrentLaunchConfiguration(): Promise<void> {
    await readLaunchConfigurations();
    let currentLaunchConfigurationName: string | undefined = extension.getState().launchConfiguration;
    if (currentLaunchConfigurationName) {
        currentLaunchConfiguration = getLaunchConfiguration(currentLaunchConfigurationName);
    }

    let launchConfigStr : string = "No launch configuration set.";
    if (currentLaunchConfiguration) {
        launchConfigStr = launchConfigurationToString(currentLaunchConfiguration);
        logger.message(`Reading current launch configuration "${launchConfigStr}" from the workspace state.`);
    } else {
        // A null launch configuration after a non empty launch configuration string name
        // means that the name stored in the project state does not match any of the entries in settings.
        // This typically happens after the user modifies manually "autotools.launchConfigurations"
        // in the .vscode/settings.json, specifically the entry that corresponds to the current launch configuration.
        // Make sure to unset the launch configuration in this scenario.
        if (currentLaunchConfigurationName !== undefined && currentLaunchConfigurationName !== "") {
            logger.message(`Launch configuration "${currentLaunchConfigurationName}" is no longer defined in settings "autotools.launchConfigurations".`);
            await setLaunchConfigurationByName("");
        } else {
            logger.message("No current launch configuration is set in the workspace state.");
        }
    }

    statusBar.setLaunchConfiguration(launchConfigStr);
    await extension._projectOutlineProvider.updateLaunchTarget(launchConfigStr);
}

export interface DefaultLaunchConfiguration {
    MIMode?: string;
    miDebuggerPath?: string;
    stopAtEntry?: boolean;
    symbolSearchPath?: string;
}

let defaultLaunchConfiguration: DefaultLaunchConfiguration | undefined;
export function getDefaultLaunchConfiguration(): DefaultLaunchConfiguration | undefined { return defaultLaunchConfiguration; }
// No setter needed. Currently only the user can define autotools.defaultLaunchConfiguration

export async function readDefaultLaunchConfiguration(): Promise<void> {
    defaultLaunchConfiguration = await util.getExpandedSetting<DefaultLaunchConfiguration>("defaultLaunchConfiguration");
    logger.message(`Default launch configuration: MIMode = ${defaultLaunchConfiguration?.MIMode},
                    miDebuggerPath = ${defaultLaunchConfiguration?.miDebuggerPath},
                    stopAtEntry = ${defaultLaunchConfiguration?.stopAtEntry},
                    symbolSearchPath = ${defaultLaunchConfiguration?.symbolSearchPath}`);
}

let configurationMakeArgs: string[] = [];
export function getConfigurationMakeArgs(): string[] { return configurationMakeArgs; }
export function setConfigurationMakeArgs(args: string[]): void { configurationMakeArgs = args; }

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
// Higher level settings (like autotools.makePath, autotools.makeDirectory)
// also have an additional effect on the final command.
export async function getCommandForConfiguration(): Promise<void> {
    configurationMakeArgs = [];

    // Add the working directory path via the -C switch.
    // makefile.configurations.makeDirectory overwrites makefile.makeDirectory.
    // top_builddir is resolved to either a subdirectory of the workspace or an absolute path.
    let makeDirectoryUsed: string = util.resolvePathToRoot(currentMakefileConfiguration.makeDirectory || "");
//    if (makeDirectoryUsed) {
//        // If out-of-tree, add -C argument
//        configurationMakeArgs.push("-C");
//        configurationMakeArgs.push(`${makeDirectoryUsed}`);
//        configurationMakefile = makeDirectoryUsed;
//    }

    // Add the makefile path via the -f make switch.
    // The make file is in makeDirectory or in the workspace directory,
    // and is named "Makefile" or "makefile".
    let makeFileTest: string | undefined;
    // filename of makefile relative to makeDirectory
    let relativeMakefile: string | undefined;
    let makefileExists : boolean = false;
    relativeMakefile = "GNUmakefile";
    makeFileTest = path.join(makeDirectoryUsed, relativeMakefile);
    makefileExists = util.checkFileExistsSync(util.resolvePathToRoot(makeFileTest));
    if (!makefileExists) {
        relativeMakefile = "Makefile";
        makeFileTest = path.join(makeDirectoryUsed, relativeMakefile);
        makefileExists = util.checkFileExistsSync(util.resolvePathToRoot(makeFileTest));
    }
    if (!makefileExists) {
        relativeMakefile = "makefile";
        makeFileTest = path.join(makeDirectoryUsed, relativeMakefile);
        makefileExists = util.checkFileExistsSync(util.resolvePathToRoot(makeFileTest));
    }

    // if we found the makefile add it to command line to ensure make has the same understanding
    // of which makefile is the correct one.
    // TODO: If the installed make _is_ GNU, then GNUmakefile should be prefered. Need to detect if
    // make is GNU or not.
    if (makefileExists) {
        configurationMakefile = relativeMakefile;
//        configurationMakeArgs.push("-f");
//        configurationMakeArgs.push(`${relativeMakefile}`);
        // Need to rethink this (GitHub 59).
        // Some repos don't work when we automatically add -C, others don't work when we don't.
        // configurationMakeArgs.push("-C");
        // configurationMakeArgs.push(path.parse(configurationMakefile).dir);

        // Make sure we append "autotools.configurations[].makeArgs" last, in case the developer wants to overwrite any arguments that the extension
        // deduces from the settings. Additionally, for -f/-C, resolve path to root.
        if (currentMakefileConfiguration.makeArgs) {
            let prevArg: string = "";
            currentMakefileConfiguration.makeArgs.forEach(arg => {
            if (prevArg === "-C") {
                configurationMakeArgs.push(util.resolvePathToRoot(arg));
            } else if (arg.startsWith("--directory")) {
                const eqIdx: number = arg.indexOf("=");
                const folderStr: string = arg.substring(eqIdx + 1, arg.length);
                configurationMakeArgs.push(`--directory=${util.resolvePathToRoot(folderStr)}`);
            } else {
                configurationMakeArgs.push(arg);
            }
            prevArg = arg;
        });
        }
        logger.message(`Deduced command '${makePath} ${configurationMakeArgs.join(" ")}' for configuration "${currentMakefileConfiguration.name}"`);
     } else {
        logger.message(`A makefile was not found for configuration "${currentMakefileConfiguration.name}"`);
     }
    // store the found makefile for display in the outline
    setConfigurationMakefile(makefileExists ? relativeMakefile : undefined);
    extension.updateMakefileFilePresent(makefileExists);

    // Validation and warnings about properly defining the makefile and make tool.
    if (!makefileExists) {
        logger.message("The makefile entry point was not found. " +
            "Make sure it exists at the location defined by " +
            "autotools.makeDirectory, autotools.configurations[].makeDirectory" +
            "or in the root of the workspace.");

        // we may need more advanced ability to process settings
        // insight into different project structures
        const telemetryProperties: telemetry.Properties = {
            reason: "no Makefile"
        };

        telemetry.logEvent("makefileNotFound", telemetryProperties);
        await extension.setFullFeatureSet(false);
        disableAllOptionallyVisibleCommands();
    } else {
        await extension.setFullFeatureSet(true);
        enableOptionallyVisibleCommands();
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

// Last target picked from the set of targets that are run by the makefiles
// when building for the current configuration.
// Saved into the settings storage. Also reflected in the configuration status bar button
// Assume the well-known "all" target for the default goal
let currentTarget: make.BuildTarget = make.t_all;
export function getCurrentTarget(): make.BuildTarget { return currentTarget; }
export function getCurrentTargetAsFilename() : string {
    return currentTarget.name.replace(/[^\w \(\)\[\]\{\}@\.\-\+]+/g,'_');
}
// Set the current target, or 'all' if none was given
export function setCurrentTarget(target: make.BuildTarget = make.t_all): void { currentTarget = target; }

// Read current target from workspace state, update status bar item
function readCurrentTarget(): void {
    let buildTarget : BuildTarget | undefined = extension.getState().buildTarget;
    setCurrentTarget(buildTarget);
    if (!buildTarget) {
        logger.message(`No target defined in the workspace state. Assuming '${currentTarget}'.`);
    } else {
        logger.message(`Reading current build target "${currentTarget}" from the workspace state.`);
    }
    statusBar.setTarget(currentTarget);
}

let configureOnOpen: boolean | undefined;
export function getConfigureOnOpen(): boolean | undefined { return configureOnOpen; }
export function setConfigureOnOpen(configure: boolean): void { configureOnOpen = configure; }
export async function readConfigureOnOpen(): Promise<void> {
    configureOnOpen = await util.getExpandedSetting<boolean>("configureOnOpen");
    logger.message(`Configure on open: ${configureOnOpen}`);
}

let configureOnEdit: boolean | undefined;
export function getConfigureOnEdit(): boolean | undefined { return configureOnEdit; }
export function setConfigureOnEdit(configure: boolean): void { configureOnEdit = configure; }
export async function readConfigureOnEdit(): Promise<void> {
    configureOnEdit = await util.getExpandedSetting<boolean>("configureOnEdit");
    logger.message(`Configure on edit: ${configureOnEdit}`);
}

let configureAfterCommand: boolean | undefined;
export function getConfigureAfterCommand(): boolean | undefined { return configureAfterCommand; }
export function setConfigureAfterCommand(configure: boolean): void { configureAfterCommand = configure; }
export async function readConfigureAfterCommand(): Promise<void> {
    configureAfterCommand = await util.getExpandedSetting<boolean>("configureAfterCommand");
    logger.message(`Configure after command: ${configureAfterCommand}`);
}

let phonyOnlyTargets: boolean | undefined;
export function getPhonyOnlyTargets(): boolean | undefined { return phonyOnlyTargets; }
export function setPhonyOnlyTargets(phony: boolean): void { phonyOnlyTargets = phony; }
export async function readPhonyOnlyTargets(): Promise<void> {
    phonyOnlyTargets = await util.getExpandedSetting<boolean>("phonyOnlyTargets");
    logger.message(`Only .PHONY targets: ${phonyOnlyTargets}`);
}

let saveBeforeBuildOrConfigure: boolean | undefined;
export function getSaveBeforeBuildOrConfigure(): boolean | undefined { return saveBeforeBuildOrConfigure; }
export function setSaveBeforeBuildOrConfigure(save: boolean): void { saveBeforeBuildOrConfigure = save; }
export async function readSaveBeforeBuildOrConfigure(): Promise<void> {
    saveBeforeBuildOrConfigure = await util.getExpandedSetting<boolean>("saveBeforeBuildOrConfigure");
    logger.message(`Save before build or configure: ${saveBeforeBuildOrConfigure}`);
}

let buildBeforeLaunch: boolean | undefined;
export function getBuildBeforeLaunch(): boolean | undefined { return buildBeforeLaunch; }
export function setBuildBeforeLaunch(build: boolean): void { buildBeforeLaunch = build; }
export async function readBuildBeforeLaunch(): Promise<void> {
    buildBeforeLaunch = await util.getExpandedSetting<boolean>("buildBeforeLaunch");
    logger.message(`Build before launch: ${buildBeforeLaunch}`);
}

let clearOutputBeforeBuild: boolean | undefined;
export function getClearOutputBeforeBuild(): boolean | undefined { return clearOutputBeforeBuild; }
export function setClearOutputBeforeBuild(clear: boolean): void { clearOutputBeforeBuild = clear; }
export async function readClearOutputBeforeBuild(): Promise<void> {
    clearOutputBeforeBuild = await util.getExpandedSetting<boolean>("clearOutputBeforeBuild");
    logger.message(`Clear output before build: ${clearOutputBeforeBuild}`);
}

// This setting is useful for some repos where directory changing commands (cd, push, pop)
// are missing or printed more than once, resulting in associating some IntelliSense information
// with the wrong file or even with a non existent URL.
// When this is set, the current path deduction relies only on --print-directory
// (which prints the messages regarding "Entering direcory" and "Leaving directory"),
// which is not perfect either for all repos.
let ignoreDirectoryCommands: boolean | undefined;
export function getIgnoreDirectoryCommands(): boolean | undefined { return ignoreDirectoryCommands; }
export function setIgnoreDirectoryCommands(ignore: boolean): void { ignoreDirectoryCommands = ignore; }
export async function readIgnoreDirectoryCommands(): Promise<void> {
    ignoreDirectoryCommands = await util.getExpandedSetting<boolean>("ignoreDirectoryCommands");
    logger.message(`Ignore directory commands: ${ignoreDirectoryCommands}`);
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
   readCurrentTarget();
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
    await readMakeDirectory();
    await readPreConfigureScript();
    await readAlwaysPreConfigure();
    await readPostConfigureScript();
    await readAlwaysPostConfigure();
    await readkeepDryRuns();
    await readkeepConfigurationCache();
    await readAdditionalCompilerNames();
    await readExcludeCompilerNames();
    await readMakefileConfigurations(currentMakefileConfigurationName);
    await readCurrentLaunchConfiguration();
    await readDefaultLaunchConfiguration();
    await readConfigureOnOpen();
    await readConfigureOnEdit();
    await readConfigureAfterCommand();
    await readPhonyOnlyTargets();
    await readSaveBeforeBuildOrConfigure();
    await readBuildBeforeLaunch();
    await readClearOutputBeforeBuild();
    await readIgnoreDirectoryCommands();
    await readCompileCommandsPath();

    initOptionalFeatures();
    await readFeaturesVisibility();

    setCurrentMakefileConfiguration(currentMakefileConfigurationName);
    await analyzeConfigureParams();

    // FIXME: seems wrong to do || make.t_all; this fn should probably be called
    // config arg after config is fully loaded.
    await extension._projectOutlineProvider.update(extension.getState().buildConfiguration,
                                             currentTarget,
                                             extension.getState().launchConfiguration);

    // Verify the dirty state of the IntelliSense config provider and update accordingly.
    // The makefile.configureOnEdit setting can be set to false when this behavior is inconvenient.
    vscode.window.onDidChangeActiveTextEditor(async e => {
        // FIXME: There is no need to reconfigure when focus changes.
        let language: string = "";
        if (e) {
            language = e.document.languageId;
        }

        // It is too annoying to generate a configure on any kind of editor focus change
        // (for example even searching in the logging window generates this event).
        // Since all the operations are guarded by the configureDirty state,
        // the only "operation" left that we need to make sure it's up to date
        // is IntelliSense, so trigger a configure when we switch editor focus
        // into C/C++ source code.
        switch (language) {
            case "c":
            case "cpp":
                // If configureDirty is already set from a previous VSCode session,
                // at workspace load this event (onDidChangeActiveTextEditor) is triggered automatically
                // and if autotools.configureOnOpen is true, there is a race between two configure operations,
                // one of which being unnecessary. If configureOnOpen is false, there is no race
                // but still we don't want to override the behavior desired by the user.
                // Additionally, if anything dirtied the configure state during a (pre)configure or build,
                // skip this clean configure, to avoid annoying "blocked operation" notifications.
                // The configure state remains dirty and a new configure will be triggered eventually:
                // (selecting a new configuration, target or launch, build, editor focus change).
                // Guarding only for not being blocked is not enough. For example,
                // in the first scenario explained above, the race happens when nothing looks blocked
                // here, but leading to a block notification soon.
                if (extension.getState().configureDirty && configureOnEdit) {
                    if ((extension.getCompletedConfigureInSession())
                        && !make.blockedByOp(make.Operations.configure, false)) {
                        logger.message("Configuring after settings or makefile changes...");
                        await make.configure(make.TriggeredBy.configureAfterEditorFocusChange); // this sets configureDirty back to false if it succeeds
                    }
                }

                break;

            default:
                break;
        }
    });

    // Modifying any makefile should trigger an IntelliSense config provider update,
    // so make the dirty state true.
    // TODO: limit to makefiles relevant to this project, instead of any random makefile anywhere.
    //       We can't listen only to the makefile pointed to by autotools.makefilePath or autotools.makeDirectory,
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
        if (vscode.workspace.workspaceFolders && e.affectsConfiguration('makefile')) {
            // We are interested in updating only some relevant properties.
            // A subset of these should also trigger an IntelliSense config provider update.
            // Avoid unnecessary updates (for example, when settings are modified via the extension quickPick).
            let telemetryProperties: telemetry.Properties | null = {};
            let updatedSettingsSubkeys: string[] = [];
            const keyRoot: string = "autotools";
            let subKey: string = "launchConfigurations";

            let updatedLaunchConfigurations : LaunchConfiguration[] | undefined = await util.getExpandedSetting<LaunchConfiguration[]>(subKey);
            if (!util.areEqual(updatedLaunchConfigurations, launchConfigurations)) {
                // Changing a launch configuration does not impact the make or compiler tools invocations,
                // so no IntelliSense update is needed.
                await readCurrentLaunchConfiguration(); // this gets a refreshed view of all launch configurations
                // and also updates the current one in case it was affected
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "defaultLaunchConfiguration";
            let updatedDefaultLaunchConfiguration : DefaultLaunchConfiguration | undefined = await util.getExpandedSetting<DefaultLaunchConfiguration>(subKey);
            if (!util.areEqual(updatedDefaultLaunchConfiguration, defaultLaunchConfiguration)) {
                // Changing a global debug configuration does not impact the make or compiler tools invocations,
                // so no IntelliSense update is needed.
                await readDefaultLaunchConfiguration();
                updatedSettingsSubkeys.push(subKey);
            }

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

            subKey = "preConfigureScript";
            let updatedPreConfigureScript : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedPreConfigureScript) {
                updatedPreConfigureScript = util.resolvePathToRoot(updatedPreConfigureScript);
            }
            if (updatedPreConfigureScript !== preConfigureScript) {
                // No IntelliSense update needed.
                await readPreConfigureScript();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "postConfigureScript";
            let updatedPostConfigureScript: string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedPostConfigureScript) {
                updatedPostConfigureScript = util.resolvePathToRoot(updatedPostConfigureScript);
            }
            if (updatedPostConfigureScript !== postConfigureScript) {
                await readPostConfigureScript();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "alwaysPreConfigure";
            let updatedAlwaysPreConfigure : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedAlwaysPreConfigure !== alwaysPreConfigure) {
                // No IntelliSense update needed.
                await readAlwaysPreConfigure();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "alwaysPostConfigure";
            let updatedAlwaysPostConfigure: boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedAlwaysPostConfigure !== alwaysPostConfigure) {
                await readAlwaysPostConfigure();
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

            subKey = "makeDirectory";
            let updatedMakeDirectory : string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedMakeDirectory !== makeDirectory) {
                // A change in autotools.makeDirectory should trigger an IntelliSense update
                // only if the extension is not currently reading from a build log.
                extension.getState().configureDirty = extension.getState().configureDirty;
                await readMakeDirectory();
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
            }

            subKey = "keepDryRuns";
            let updatedkeepDryRuns : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedkeepDryRuns !== keepDryRuns) {
                await readkeepDryRuns();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "keepConfigurationCache";
            let updatedkeepConfigurationCache : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (keepConfigurationCache !== keepConfigurationCache) {
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

            subKey = "configureOnOpen";
            let updatedConfigureOnOpen : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedConfigureOnOpen !== configureOnOpen) {
                await readConfigureOnOpen();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "configureOnEdit";
            let updatedConfigureOnEdit : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedConfigureOnEdit !== configureOnEdit) {
                await readConfigureOnEdit();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "configureAfterCommand";
            let updatedConfigureAfterCommand : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedConfigureAfterCommand !== configureAfterCommand) {
                await readConfigureAfterCommand();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "phonyOnlyTargets";
            let updatedPhonyOnlyTargets : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedPhonyOnlyTargets !== phonyOnlyTargets) {
                await readPhonyOnlyTargets();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "saveBeforeBuildOrConfigure";
            let updatedSaveBeforeBuildOrConfigure : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedSaveBeforeBuildOrConfigure !== saveBeforeBuildOrConfigure) {
                await readSaveBeforeBuildOrConfigure();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "buildBeforeLaunch";
            let updatedBuildBeforeLaunch : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedBuildBeforeLaunch !== buildBeforeLaunch) {
                await readBuildBeforeLaunch();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "clearOutputBeforeBuild";
            let updatedClearOutputBeforeBuild : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedClearOutputBeforeBuild !== clearOutputBeforeBuild) {
                await readClearOutputBeforeBuild();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "ignoreDirectoryCommands";
            let updatedIgnoreDirectoryCommands : boolean | undefined = await util.getExpandedSetting<boolean>(subKey);
            if (updatedIgnoreDirectoryCommands !== ignoreDirectoryCommands) {
                await readIgnoreDirectoryCommands();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "compileCommandsPath";
            let updatedCompileCommandsPath: string | undefined = await util.getExpandedSetting<string>(subKey);
            if (updatedCompileCommandsPath) {
                updatedCompileCommandsPath = util.resolvePathToRoot(updatedCompileCommandsPath);
            }
            if (updatedCompileCommandsPath !== compileCommandsPath) {
                await readCompileCommandsPath();
                updatedSettingsSubkeys.push(subKey);
            }

            subKey = "panel.visibility";
            let wasLocalDebugEnabled: boolean = isOptionalFeatureEnabled("debug");
            let wasLocalRunningEnabled: boolean   = isOptionalFeatureEnabled("run");
            await readFeaturesVisibility();
            enableOptionallyVisibleCommands();
            let isLocalDebugEnabled: boolean = isOptionalFeatureEnabled("debug");
            let isLocalRunningEnabled: boolean   = isOptionalFeatureEnabled("run");
            if ((wasLocalDebugEnabled !== isLocalDebugEnabled) || (wasLocalRunningEnabled !== isLocalRunningEnabled)) {
                extension._projectOutlineProvider.updateTree();
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
    // Cannot set a new makefile configuration if the project is currently building or (pre-)configuring.
    if (make.blockedByOp(make.Operations.changeConfiguration)) {
        return;
    }

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

        if (configureAfterCommand) {
            logger.message("Automatically reconfiguring the project after a makefile configuration change.");
            await make.cleanConfigure(make.TriggeredBy.configureAfterConfigurationChange);
        }

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

export async function setTargetByName(targetName: make.BuildTarget) : Promise<void> {
    currentTarget = targetName;
    let displayTarget: string = targetName.name ? `${currentTarget.name} @ ${currentTarget.dir}`: "Default";
    statusBar.setTarget(currentTarget);
    logger.message(`Setting target ${displayTarget}`);
    logger.message("Re-reading settings after target change.");
    // Refresh settings, they may reference variables or commands reading state target var (${buildTarget}).
    extension.getState().buildTarget = currentTarget;
    await initFromSettings();
    extension._projectOutlineProvider.updateBuildTarget(targetName);
}

// Fill a drop-down with all the target names run by building the makefile for the current configuration
// Triggers a cpptools configuration provider update after selection.
// TODO: change the UI list to multiple selections mode and store an array of current active targets
export async function selectTarget(context: vscode.ExtensionContext): Promise<void> {
    // Cannot select a new target if the project is currently building or (pre-)configuring.
    if (make.blockedByOp(make.Operations.changeBuildTarget)) {
        return;
    }

    // warn about an out of date configure state and configure if makefile.configureAfterCommand allows.
    if (extension.getState().configureDirty ||
        // The configure state might not be dirty from the last session but if the project is set to skip
        // configure on open and no configure happened yet we still must warn.
        (configureOnOpen === false && !extension.getCompletedConfigureInSession())) {
        logger.message("The project needs a configure to populate the build targets correctly.");
        if (configureAfterCommand) {
            let retc: number = await make.configure(make.TriggeredBy.configureBeforeTargetChange);
            if (retc !== make.ConfigureBuildReturnCodeTypes.success) {
                logger.message("The build targets list may not be accurate because configure failed.");
            }
        }
    }

    let options: vscode.QuickPickOptions = {};
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus

    // Ensure "all" is always available as a target to select.
    // There are scenarios when "all" might not be present in the list of available targets,
    // for example when the extension is using a build log or dryrun cache of a previous state
    // when a particular target was selected and a dryrun applied on that is producing a subset of targets,
    // making it impossible to select "all" back again without resetting the Makefile Tools state
    // or switching to a different makefile configuration or implementing an editable target quick pick.
    // Another situation where "all" would inconveniently miss from the quick pick is when the user is
    // providing a build log without the required verbosity for parsing targets (-p or --print-data-base switches).
    // When the extension is not reading from build log or dryrun cache, we have logic to prevent
    // "all" from getting lost: make sure the target is not appended to the make invocation
    // whose output is used to parse the targets (as opposed to parsing for IntelliSense or launch targets
    // when the current target must be appended to the make command).
    // FIXME: commit this separately. "all" cannot be forced if the Makefile doesn't mention it.
    // if (!buildTargets.includes("all")) {
    //     buildTargets.push("all");
    // }

//    const options: { [key: string]: (context: ExtensionContext) => Promise<void> } = {
//            showQuickPick,
//            showInputBox,
//            multiStepInput,
//            quickOpen,
//        };
    const quickPick = vscode.window.createQuickPick();
    //quickPick.items = Object.keys(options).map(label => ({ label }));
    quickPick.items = Array.from(buildTargets.keys())
        .map(label => ({ label }));
    
    Object.keys(options).map(label => ({ label }));
    quickPick.onDidChangeSelection(selection => {
        if (selection[0]) {
            //options[selection[0].label](context)
            //    .catch(console.error);
        }
    });
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();

    const chosen = await multiStep.multiStepInput(context);

    if (chosen instanceof BuildTarget) {
        return;
    }
    if (chosen && chosen !== getCurrentTarget()) {
        const telemetryProperties: telemetry.Properties = {
            state: "buildTarget"
        };
        telemetry.logEvent("stateChanged", telemetryProperties);

        await setTargetByName(chosen);

        if (configureAfterCommand) {
            // The set of build targets remains the same even if the current target has changed
            logger.message("Automatically reconfiguring the project after a build target change.");
            await make.cleanConfigure(make.TriggeredBy.configureAfterTargetChange, false);
        }
    }
}

// The 'name' of a launch configuration is a string following this syntax:
//    [cwd]>[binaryPath](binaryArg1,binaryArg2,...)
// These strings are found by the extension while parsing the output of the dry-run or build log,
// which reflect possible different ways of running the binaries built by the makefile.
// TODO: If we find that these strings are not unique (meaning the makefile may invoke
// the given binary in the exact same way more than once), incorporate also the containing target
// name in the syntax (or, since in theory one can write a makefile target to run the same binary
// in the same way more than once, add some number suffix).
export async function setLaunchConfigurationByName(launchConfigurationName: string) : Promise<void> {
    // Find the matching entry in the array of launch configurations
    // or generate a new entry in settings if none are found.
    currentLaunchConfiguration = getLaunchConfiguration(launchConfigurationName);
    if (!currentLaunchConfiguration) {
        currentLaunchConfiguration = await stringToLaunchConfiguration(launchConfigurationName);
        if (currentLaunchConfiguration) {
            // Read again all launch configurations from settings, so that we push this incoming into that array as well
            // because we want to persist the original unexpanded content of launch configurations.
            let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("autotools");
            let launchConfigAsInSettings: LaunchConfiguration[] = workspaceConfiguration.get<LaunchConfiguration[]>("launchConfigurations") || [];
            launchConfigAsInSettings.push(currentLaunchConfiguration);
            // Push into the processed 'in-memory' launch configurations array as well.
            launchConfigurations.push(currentLaunchConfiguration);
            await workspaceConfiguration.update("launchConfigurations", launchConfigAsInSettings);
            logger.message(`Inserting a new entry for ${launchConfigurationName} in the array of autotools.launchConfigurations. ` +
                           "You may define any additional debug properties for it in settings.");
        }
    }

    if (currentLaunchConfiguration) {
        logger.message(`Setting current launch target "${launchConfigurationName}"`);
        extension.getState().launchConfiguration = launchConfigurationName;
        statusBar.setLaunchConfiguration(launchConfigurationName);
    } else {
        if (launchConfigurationName === "") {
            logger.message("Unsetting the current launch configuration.");
        } else {
            logger.message(`A problem occured while analyzing launch configuration name ${launchConfigurationName}. Current launch configuration is unset.`);
        }
        extension.getState().launchConfiguration = undefined;
        statusBar.setLaunchConfiguration("No launch configuration set");
    }

    // Refresh settings, they may reference variables or commands reading launch targets commands: ${command:autotools.getLaunchTargetPath} and others...
    logger.message("Re-reading settings after launch target change.");
    await initFromSettings();
    await extension._projectOutlineProvider.updateLaunchTarget(launchConfigurationName);
}

// Fill a drop-down with all the launch configurations found for binaries built by the makefile
// under the scope of the current build configuration and target
// Selection updates current launch configuration that will be ready for the next debug/run operation
export async function selectLaunchConfiguration(): Promise<void> {
    // Cannot select a new launch configuration if the project is currently building or (pre-)configuring.
    if (make.blockedByOp(make.Operations.changeLaunchTarget)) {
        return;
    }

    // warn about an out of date configure state and configure if autotools.configureAfterCommand allows.
    if (extension.getState().configureDirty ||
        // The configure state might not be dirty from the last session but if the project is set to skip
        // configure on open and no configure happened yet we still must warn.
        (configureOnOpen === false && !extension.getCompletedConfigureInSession())) {
        logger.message("The project needs a configure to populate the launch targets correctly.");
        if (configureAfterCommand) {
            let retc: number = await make.configure(make.TriggeredBy.configureBeforeLaunchTargetChange);
            if (retc !== make.ConfigureBuildReturnCodeTypes.success) {
                logger.message("The launch targets list may not be accurate because configure failed.");
            }
        }
    }

    // TODO: create a quick pick with description and details for items
    // to better view the long targets commands

    // In the quick pick, include also any autotools.launchConfigurations entries,
    // as long as they exist on disk and without allowing duplicates.
    let launchTargetsNames: string[] = [...launchTargets];
    launchConfigurations.forEach(launchConfiguration => {
        if (util.checkFileExistsSync(launchConfiguration.binaryPath)) {
            launchTargetsNames.push(launchConfigurationToString(launchConfiguration));
        }
    });
    launchTargetsNames = util.sortAndRemoveDuplicates(launchTargetsNames);
    let options: vscode.QuickPickOptions = {};
    options.ignoreFocusOut = true; // so that the logger and the quick pick don't compete over focus
    if (launchTargets.length === 0) {
        options.placeHolder = "No launch targets identified";
    }
    const chosen: string | undefined = await vscode.window.showQuickPick(launchTargetsNames, options);

    if (chosen) {
        let currentLaunchConfiguration: LaunchConfiguration | undefined = getCurrentLaunchConfiguration();
        if (!currentLaunchConfiguration || chosen !== launchConfigurationToString(currentLaunchConfiguration)) {
            let telemetryProperties: telemetry.Properties | null = {
                state: "launchConfiguration"
            };
            telemetry.logEvent("stateChanged", telemetryProperties);

            await setLaunchConfigurationByName(chosen);

            // Refresh telemetry for this new launch configuration
            // (this will find the corresponding item in the autotools.launchConfigurations array
            // and report all the relevant settings of that object).
            // Because of this, the event name is still "settingsChanged", even if
            // we're doing a state change now.
            let keyRoot: string = "autotools";
            let subKey: string = "launchConfigurations";
            let key: string = keyRoot + "." + subKey;
            let workspaceConfiguration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(keyRoot);
            telemetryProperties = {};

            // We should have at least one item in the launchConfigurations array
            // if the extension changes state for launch configuration,
            // but guard just in case.
            let launchConfigurationSetting: any = workspaceConfiguration[subKey];
            if (launchConfigurationSetting) {
                try {
                    telemetryProperties = await telemetry.analyzeSettings(launchConfigurationSetting, key,
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
}

// List of targets defined in the makefile project.
// Parsed from the build log, configuration cache or live dry-run output at configure time.
// Currently, this list contains any abstract intermediate target
// (like any object produced by the compiler from a source code file).
// TODO: filter only the relevant targets (binaries, libraries, etc...) from this list.
let buildTargets: Map<string, Goal[]> = new Map();
export function getBuildTargets(dir: string): Goal[] { return buildTargets.get(dir) || []; }
export function setBuildTargets(targets: Map<string, Goal[]>): void { buildTargets = targets; }
export function getAllBuildTargets(): Map<string, Goal[]> { return buildTargets; }

// List of all the binaries built by the current project and all the ways
// they may be invoked (from what cwd, with what arguments).
// This is parsed from the build log, configuration cache or live dry-run output at configure time.
// This is what populates the 'launch targets' quick pick and is different than the
// launch configurations defined in settings.
// A launch configuration extends a launch target with various debugger settings.
// Each launch configuration entry is written in settings by the extension
// when the user actively selects any launch target from the quick pick.
// Then the user can add any of the provided extra attributes (miMode, miDebuggerPath, etc...)
// under that entry. It is possible that not all launch targets have a launch configuration counterpart,
// but if they do it is only one. Technically, we can imagine one launch target may have
// more than one launch configurations defined in settings (same binary, location and arguments debugged
// with different scenarios)) but this is not yet supported because currently the launch configurations
// are uniquely referenced by a string formed by cwd, binary and args (which form a launch target).
// The quick pick is not populated by the launch configurations list because its entries may be
// out of date and most importantly a subset. We want the quick pick to reflect all the possibilities
// that are found available with the current configuration of the project.
let launchTargets: string[] = [];
export function getLaunchTargets(): string[] { return launchTargets; }
export function setLaunchTargets(targets: string[]): void { launchTargets = targets; }
