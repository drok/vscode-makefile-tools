import * as path from 'path';
import * as vscode from 'vscode';
import { getCurrentTarget,
        getCurrentMakefileConfiguration,
        MakefileConfiguration } from './configuration';
import { BuildTarget } from './make';
import { DebugConfigurationProvider, WorkspaceFolder, DebugConfiguration, ProviderResult } from 'vscode';
import { resolvePathToRoot, getSettingOr } from './util';
import * as configuration from './configuration';
import { Goal } from './parser/gnumake';
import { extension } from './extension';

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
    return !!(goal.flags & Goal.Flags.Linked_binary);
}
class MyConfiguration implements vscode.DebugConfiguration {
    constructor(built: BuildTarget) {
        this.$comment = [
            "Debug a hardcoded target in any build configuration; customize environment and args as needed",
            "The 'cwd' is set automatically to demonstrate how",
            "This is a (carefully designed) template, but it can be editted as needed"
        ];
        this.type = "autotools";
        this.name = "Debug '" + built.goal + "'" +
            (built.builddir ? " in " + built.builddir : "");
        this.request = "launch";
        this.program = "$(command:autotools.builddir)/" +
            (built.builddir ? path.join(built.builddir, built.goal) :
            built.goal);
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
    constructor(c: MakefileConfiguration, goal: Goal | undefined, built: BuildTarget, buildit: boolean, public env?: configuration.TestEnvironment) {
        this.$comment = [
            "Debug a hardcoded target in any build configuration; customize environment and args as needed",
            "The 'cwd' is set automatically to demonstrate how",
            "This is a (carefully designed) template, but it can be editted as needed"
        ];
        this.type = "autotools";
        this.name = "Debug '" + built.goal + "'" +
            (built.builddir ? " in " + built.builddir : "") + ` @ ${env?.name ?? extension.userEnvName}`;
        this.request = "launch";
        this.program =
            resolvePathToRoot( buildit ?
                path.join(c.top_builddir, (built.builddir ? path.join(built.builddir, built.goal) :
            built.goal)):
            path.join(built.builddir, built.goal));
        this.environment = [{
            name: "srcdir",
            value: resolvePathToRoot(built.builddir)
        }]
        if (goal?.depends?.length) {
            let bingoal = goal.depends[0];
            if (bingoal.flags & Goal.Flags.Libtool_Linked) {
                let libtool = resolvePathToRoot(path.join(c.top_builddir, 'libtool'))
                this.miDebuggerPath = extension.ltLauncher;
                this.miDebuggerArgs = `gdb ${libtool} ${this.program}`;
                this.MIMode = 'gdb';
                this.externalConsole = false;
            }
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
        this.stopAtEntry = getSettingOr<boolean>("stopAtEntry", false);
        //this.preLaunchTask = buildit ? "autotools: build " + built.goal +
        //    (built.builddir ? (' in ' + built.builddir) : ' at the top') : undefined;
        this.cwd = resolvePathToRoot(path.join(c.top_builddir, built.builddir));
        this.setupCommands = defaultSetupCommands;
        this.testUri = goal?.test?.uri?.with({scheme: "test"}) ?? vscode.Uri.from({scheme: "debug", path: this.cwd});
    }
    testUri: vscode.Uri | undefined;
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

  provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
    // Return an array of debug configurations
    // let c = getCurrentMakefileConfiguration();
    return getCurrentTarget()
        .then(goal => {
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
        let conf = getCurrentTarget()
            .then(goal => new DebugNow(getCurrentMakefileConfiguration(), undefined, goal, true, configuration.getCurrentTestEnvironment()));
        return conf
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
    new MyDebugProvider()
    // new MyDebugProvider()
  ];

//  const provider = new MyDebugProvider();
  // Register the debug configuration provider
  providers.forEach((provider) =>
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('autotools', provider,
        vscode.DebugConfigurationProviderTriggerKind.Initial)));
}
