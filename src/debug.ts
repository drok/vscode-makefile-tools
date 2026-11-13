import * as path from 'path';
import * as vscode from 'vscode';
import { DebugConfigurationProvider, WorkspaceFolder, DebugConfiguration, ProviderResult } from 'vscode';
import * as configuration from './configuration';
import { Goal } from './parser/gnumake';
import { CppDbg } from './cppdbg';
import { VGdb } from './vgdb';
import { DebugNow, defaultSetupCommands } from './debugnow';

export function isDebuggable(goal: Goal) : boolean {
    return true;
}
export class MyConfiguration implements vscode.DebugConfiguration {
    constructor(goal: Goal) {
        this.$comment = [
            "Debug a hardcoded target in any build configuration; customize environment and args as needed",
            "The 'cwd' is set automatically to demonstrate how",
            "This is a (carefully designed) template, but it can be editted as needed"
        ];
        this.type = "autotools";
        this.name = "Debug '" + goal.goal + "'" +
            (goal.make.dir ? " in " + goal.make.dir : "");
        this.request = "launch";
        this.program = "$(command:autotools.builddir)/" +
            (goal.make.dir ? path.join(goal.make.dir, goal.goal!) :
            goal.goal);
        this.args = [];
        this.stopAtEntry = true;

        this.cwd = "$(command:autotools.builddir)";
        this.setupCommands = defaultSetupCommands;
    }
    $comment: string[];
    name: string;
    type: string;
    request: string;
    program: string;
    args: string[];
    stopAtEntry: boolean;
    goal: Goal | undefined;
    cwd: string;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];
}

export function findDebugger(lang: string) : string | undefined {
    // Iterate through all active extensions to find any contributing debuggers
    // Debuggers register themselves via 'debuggers' contribution points in package.json
    for (const ext of vscode.extensions.all) {
        const packageJSON = ext.packageJSON;
        if (packageJSON && packageJSON.contributes && packageJSON.contributes.debuggers) {
            const debuggers = packageJSON.contributes.debuggers;
            // Each debugger defines a 'type' (e.g., 'cppdbg', 'cppvsdbg', 'lldb')
            for (const dbg of debuggers) {
                console.log(`${packageJSON.name}: Type: ${dbg.type}, Label: ${dbg.label}, Languages: ${dbg.languages}`);
                if (dbg.type == 'lldb')
                    continue;
                if (dbg.type != 'vgdb')
                    continue;
                    return dbg.type; // Return the type of the first debugger found
            }
        }
    }
    return undefined; // No debuggers found
}

export function debugGoal(log: Goal | undefined, goal: Goal, testEnv?: configuration.TestEnvironment) : vscode.DebugConfiguration
{
    const type = testEnv?.debugger || goal.make.ctx.fc.config.defaultDebugger || goal.make.ctx.fc.defaultDebugger || findDebugger("cpp") || "cppdbg";
    switch (type) {
        case 'cppdbg': return new CppDbg(log, goal, testEnv);
        case 'vgdb': return new VGdb(log, goal, testEnv);
        default: return new DebugNow(log, goal, testEnv);
    }
}

class MyDebugProvider implements DebugConfigurationProvider {
    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
            switch (e.event) {
                case "exited":
                    break;
                default:
                    break;
            }
            console.debug(e);
        }));
    }

  provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
    if (folder) {
        let fc = configuration.getFolderConfig(folder);
        return fc.getCurrentTarget().then(goal => {
            return [new MyConfiguration(goal),
            {
                $comment: [
                    "Select the build target with 'Configure Default Build Task'",
                    "Note that debugging tests is built in, does not use launch.json"
                ],
                type: 'autotools',
                name: 'Autotools: Debug the default build target',
                request: 'launch',
                args: [],
                environment: [],
                program: "^\"\\${command:autotools.default_program}\"",
                preLaunchTask: "^\"\\${command:autotools.default_program_build_task}\"",
                cwd: "^\"\\${workspaceFolder}\"",
                stopAtEntry: true,
                setupCommands: defaultSetupCommands
            }];
        });
    } else {
        return [];
    }
  }


  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration): ProviderResult<DebugConfiguration> {
    // If needed, modify the debug configuration before launching the debug session
    if (config.type === undefined) {
        if (folder) {
            let fc = configuration.getFolderConfig(folder);
            let conf = fc.getCurrentTarget()
                .then(goal => new DebugNow(undefined, goal, fc.currentTestEnvironment));
            return conf;
        }
    }
    if (config.type != "autotools")
        return undefined;

    let folderDebugger : string | undefined;
    if (folder) {
        let fc = configuration.getFolderConfig(folder);
        folderDebugger = fc.config.defaultDebugger || fc.defaultDebugger;
    }

    config.type = config.env.testDebugEnv.debugger || folderDebugger || findDebugger("cpp") || "cppdbg";
    return config;
  }

  resolveDebugConfigurationWithSubstitutedVariables?(folder: WorkspaceFolder | undefined,
        debugConfiguration: DebugConfiguration, token?: vscode.CancellationToken): ProviderResult<DebugConfiguration> {
    if (debugConfiguration.type == "autotools")
        debugConfiguration.type = "cppdbg";
    return debugConfiguration;
  }

}

export function activate(context: vscode.ExtensionContext) {
  const providers = [
    new MyDebugProvider(context)
  ];

  // Register the debug configuration provider
  providers.forEach((provider) =>
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('autotools', provider,
        vscode.DebugConfigurationProviderTriggerKind.Initial)));
}
