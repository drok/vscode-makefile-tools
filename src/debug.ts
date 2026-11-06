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
import { env } from 'process';

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
        // this.debugger = "lldb";
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
    // debugger: string | undefined;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];
}

function findDebugger(lang: string) : string | undefined {
    // 1. Check if specific C++ extensions are installed
    //const cppExt = vscode.extensions.getExtension('ms-vscode.cpptools');
    //const lldbExt = vscode.extensions.getExtension('vadimcn.vscode-lldb');
//
    //console.log("Microsoft C/C++ extension installed:", !!cppExt);
    //console.log("CodeLLDB extension installed:", !!lldbExt);

    // 2. You can iterate through all active extensions to find any contributing debuggers
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
                //if (dbg.languages/* && dbg.languages.includes(lang)*/)
                    return dbg.type; // Return the type of the first debugger found
            }
        }
    }
    return undefined; // No debuggers found
}

/* this configuration is used when "Run and Debug" is clicked.
 * the builddir is pre-populated
 */
export class DebugNow implements vscode.DebugConfiguration {
    constructor(log: Goal | undefined, goal: Goal, public testEnv?: configuration.TestEnvironment) {
        this.$comment = [
            "Debug a hardcoded target in any build configuration; customize environment and args as needed",
            "The 'cwd' is set automatically to demonstrate how",
            "This is a (carefully designed) template, but it can be editted as needed"
        ];
        this.type = testEnv?.debugger || findDebugger("cpp") || "cppdbg";
        // this.type = "autotools";
        this.name = "Debug '" + goal.goal + "'" +
            (goal.make.dir ? " in " + goal.make.dir : "") + ` @ ${testEnv?.name ?? extension.userEnvName}`;
        this.request = "launch";
        this.environment = [{
            name: "srcdir",
            value: path.join(goal.make.ctx.fc.folder.uri.path, goal.make.dir)
        }]
        this.env = {
            srcdir: path.join(goal.make.ctx.fc.folder.uri.path, goal.make.dir)
        };
        // let gdb='/home/radu/bin/gdb-9/bin/gdb';
        let gdb='gdb';
        switch (this.type) {
            case "cppdbg": // Environment set is called .environment and uses the name: ... value: ... format
                this.program = goal.getFilePath();
                this.args = [];
                if (goal.flags & Goal.Flags.Libtool_Linked) {
                    let libtool = path.join(goal.make.ctx.root, 'libtool');
                    this.miDebuggerPath = extension.ltLauncher;
                    this.miDebuggerArgs = `${gdb} ${libtool} ${this.program}`;
                    this.MIMode = 'gdb';
                    this.externalConsole = false;
                } else {
                    this.miDebuggerPath = extension.integratedLauncher;
                    this.miDebuggerArgs = `${gdb} ${this.program}`;
                    this.MIMode = 'gdb';
                    this.externalConsole = false;
                }

                if (testEnv) {
                    if (testEnv.testDebugEnv)
                        Object.entries(testEnv.testDebugEnv).forEach(([k,v]) => {
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
                break;
            // Default:
            default:
                this.program = 'sh';
                this.debugger = extension.integratedLauncher;
                this.debuggerArgs = [gdb, goal.getFilePath()];
                this.args = [ goal.getFilePath() ];
                if (goal.flags & Goal.Flags.Libtool_Linked) {
                    let libtool = path.join(goal.make.ctx.root, 'libtool');
                    this.MIMode = 'gdb';
                    this.externalConsole = false;
                } else {
                    this.MIMode = 'gdb';
                    this.externalConsole = false;
                }
                if (testEnv) {
                    if (testEnv.testDebugEnv)
                        Object.entries(testEnv.testDebugEnv).forEach(([k,v]) => {
                            this.env[k] = v;
                        });
                }
                Object.entries(frameworks_support).forEach(([k,v]) => {
                            this.env[k] = v;
                });
                break;
        }
        /* enable the debugging extension's debug trace */
        if (true) {
            switch (this.type) {
                case 'vgdb': this.debug = 'verbose';
                            break;
            }
        }
        this.stopAtEntry = goal ? getSettingOr<boolean>(goal.make.ctx.fc.folder, "stopAtEntry", false) : true;
        //this.preLaunchTask = buildit ? "autotools: build " + built.goal +
        //    (built.builddir ? (' in ' + built.builddir) : ' at the top') : undefined;
        this.cwd = goal.make.getDir();
        this.setupCommands = defaultSetupCommands;
        // this.testId = log?.test?.id || 'unk';
        // this.debugger = env?.debugger;
        this.testUri = log?.test?.uri?.with({scheme: "test"}) ?? vscode.Uri.from({scheme: "debug", path: this.cwd});
        // this.env = env;
    }
    // env: configuration.TestEnvironment;
    // testId: string;
    testUri: vscode.Uri;
    $comment: string[];
    name: string;
    type: string;
    request: string;
    program: string;
    environment: { name: string, value: string }[];
    env: { [key: string]: string };
    args: string[];
    stopAtEntry: boolean;
    //preLaunchTask: string | undefined;
    cwd: string;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];

    /* controls for particular debuggers */
    /* vgdb: */
    debug?: string;
    debugger?: string;
    debuggerArgs?: string[];


    /* cppdbg */
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
