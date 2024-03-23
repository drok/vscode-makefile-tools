import * as path from 'path';
import * as vscode from 'vscode';
import {
        MakefileConfiguration } from './configuration';
import { BuildTarget } from './make';
import { DebugConfigurationProvider, WorkspaceFolder, DebugConfiguration, ProviderResult } from 'vscode';
import { getSettingOr } from './util';
import * as configuration from './configuration';
import { Goal } from './parser/gnumake';
import { Extension, extension } from './extension';

let defaultSetupCommands = [{
    "description": "Set source directory",
    "text": "-environment-directory ${workspaceFolder}",
    "ignoreFailures": false
},
{
    "description": "Enable pretty-printing for gdb",
    "text": "-enable-pretty-printing",
    "ignoreFailures": true
}
];

const frameworks_support : { [key: string]: string } =
{
    /* Google Test
     * https://google.github.io/googletest/advanced.html#turning-assertion-failures-into-break-points
     */
    GTEST_BREAK_ON_FAILURE: "1",
    GTEST_CATCH_EXCEPTIONS: "0",

    /* Check
     * https://libcheck.github.io/check/doc/check_html/check_7.html#Environment-Variable-Reference
     */
    CK_FORK: "no",
}

export function isDebuggable(goal: Goal) : boolean {
    return true;
}
class MyConfiguration implements vscode.DebugConfiguration {
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
        this.environment = [];
        this.args = [];
        this.stopAtEntry = true;
        // cpptools understands tasks to be those it can provide itself.
        // this.preLaunchTask = "autotools: build " + built.goal + "" +
        //     (built.builddir ? (' in ' + built.builddir) : ' at the top');

        this.cwd = "$(command:autotools.builddir)";
        this.setupCommands = defaultSetupCommands;
    }
    $comment: string[];
    name: string;
    type: string;
    request: string;
    program: string;
    environment: { name: string, value: string }[];
    args: string[];
    stopAtEntry: boolean;
    goal: Goal | undefined;
    // preLaunchTask: string;
    cwd: string;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];
}

/* this configuration is used when "Run and Debug" is clicked.
 * the builddir is pre-populated
 */
export class DebugNow implements vscode.DebugConfiguration {
    constructor(log: Goal | undefined, goal: Goal, public env?: configuration.TestEnvironment) {
        this.$comment = [
            "Debug a hardcoded target in any build configuration; customize environment and args as needed",
            "The 'cwd' is set automatically to demonstrate how",
            "This is a (carefully designed) template, but it can be editted as needed"
        ];
        this.type = "autotools";
        this.name = "Debug '" + goal.goal + "'" +
            (goal.make.dir ? " in " + goal.make.dir : "") + ` @ ${env?.name ?? extension.userEnvName}`;
        this.request = "launch";
        this.program = path.join(goal.make.getDir(), goal.goal!);
        this.environment = [{
            name: "srcdir",
            value: path.join(goal.make.ctx.fc.folder.uri.path, goal.make.dir)
        }]
        if (goal.flags & Goal.Flags.Libtool_Linked) {
            let libtool = path.join(goal.make.ctx.root, 'libtool');
            this.miDebuggerPath = extension.ltLauncher;
            this.miDebuggerArgs = `gdb ${libtool} ${this.program}`;
            this.MIMode = 'gdb';
            this.externalConsole = false;
        } else {
            this.miDebuggerPath = extension.integratedLauncher;
            this.miDebuggerArgs = `gdb none ${this.program}`;
            this.MIMode = 'gdb';
            this.externalConsole = false;
        }
        if (env) {
            if (env.testDebugEnv)
                Object.entries(env.testDebugEnv).forEach(([k,v]) => {
                    this.environment.push({
                        name: k,
                        value: v
                    });
                });
        }
        Object.entries(frameworks_support).forEach(([k,v]) => {
            this.environment.push({
                name: k,
                value: v
            });
        });
        this.args = [];
        this.stopAtEntry = goal ? getSettingOr<boolean>(goal.make.ctx.fc.folder, "stopAtEntry", false) : true;
        //this.preLaunchTask = buildit ? "autotools: build " + built.goal +
        //    (built.builddir ? (' in ' + built.builddir) : ' at the top') : undefined;
        this.cwd = path.dirname(goal.getFilePath()); // path.resolve(goal.make.ctx.root, goal;
        this.setupCommands = defaultSetupCommands;
        // this.testId = log?.test?.id || 'unk';
        this.testUri = log?.test?.uri?.with({scheme: "test"}) ?? vscode.Uri.from({scheme: "debug", path: this.cwd});
    }
    // testId: string;
    testUri: vscode.Uri;
    $comment: string[];
    name: string;
    type: string;
    request: string;
    program: string;
    environment: { name: string, value: string }[];
    args: string[];
    stopAtEntry: boolean;
    //preLaunchTask: string | undefined;
    cwd: string;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];

    /* mi params used for debugging Libtool bins */
    miDebuggerPath?: string;
    miDebuggerArgs?: string;
    MIMode?: string;
    additionalSOLibSearchPath?: string;
    externalConsole?: boolean;
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
//            let zz : vscode.DebugSessionCustomEvent = e;
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
//    let r : DebugConfiguration;
//    r = Promise.resolve(t.then(goal =>
//        r = new MyConfiguration(goal.builddir, goal.goal)));
    //return[new MyConfiguration(t.builddir, t.goal)];
//    return [
//        {
//            type: 'autotools',
//            name: 'Autotool Test Debug 2',
//            request: 'launch',
//            program: "zzz-2", // configuration.getDebugProgram(), // Get the program to be debugged
//            // Additional configuration properties specific to cppdbg debugger
//        },
//        {
//        type: 'autotools',
//        name: 'Autotool Test Debug',
//        request: 'launch',
//        program: "zzz", // configuration.getDebugProgram(), // Get the program to be debugged
//        // Additional configuration properties specific to cppdbg debugger
//      }
//    ];
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
        //return null;
        // return new MyConfiguration("dir-name", "test-name");
    }
    if (config.type != "autotools")
        return undefined;
    config.type = "cppdbg";
    return config;
  }

  resolveDebugConfigurationWithSubstitutedVariables?(folder: WorkspaceFolder | undefined,
        debugConfiguration: DebugConfiguration, token?: vscode.CancellationToken): ProviderResult<DebugConfiguration> {
    // return this.resolveDebugConfiguration(folder, debugConfiguration);
    if (debugConfiguration.type == "autotools")
        debugConfiguration.type = "cppdbg";
    return debugConfiguration;
  }

}

export function activate(context: vscode.ExtensionContext) {
  const providers = [
    new MyDebugProvider(context)
    // new MyDebugProvider()
  ];

//  const provider = new MyDebugProvider();
  // Register the debug configuration provider
  providers.forEach((provider) =>
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('autotools', provider,
        vscode.DebugConfigurationProviderTriggerKind.Initial)));
}
