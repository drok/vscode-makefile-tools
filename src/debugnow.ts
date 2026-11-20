import * as vscode from 'vscode';
import { Goal } from './parser/gnumake';
import * as configuration from './configuration';
import { findDebugger } from './debug';
import { getSettingOr } from './util';
import { extension } from './extension';

export const defaultSetupCommands = [{
    "description": "Set source directory",
    "text": "-environment-directory ${workspaceFolder}",
    "ignoreFailures": false
},
{
    "description": "Do not prompt anything. The debug adapter does not handle prompts.",
    "text": "-gdb-set confirm off",
    "ignoreFailures": true
},
{
    "description": "Enable pretty-printing for gdb",
    "text": "-enable-pretty-printing",
    "ignoreFailures": true
}
];

export const frameworks_support : { [key: string]: string } =
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
        this.type = testEnv?.debugger || goal.make.ctx.fc.config.defaultDebugger || goal.make.ctx.fc.defaultDebugger || findDebugger("cpp") || "cppdbg";
        this.name = "Debug '" + goal.goal + "'" +
            (goal.make.dir ? " in " + goal.make.dir : "") + ` @ ${testEnv?.name ?? extension.userEnvName}`;
        this.request = "launch";
        /* enable the debugging extension's debug trace */
        this.stopAtEntry = goal ? getSettingOr<boolean>(goal.make.ctx.fc.folder, "stopAtEntry", false) : true;
        this.cwd = goal.make.getDir();
        this.testUri = log?.test?.uri?.with({scheme: "test"}) ?? vscode.Uri.from({scheme: "debug", path: this.cwd});
    }
    testUri: vscode.Uri;
    $comment: string[];
    name: string;
    type: string;
    request: string;
    stopAtEntry: boolean;
    cwd: string;
}
