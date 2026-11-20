import * as path from 'path';
import { TestEnvironment } from './configuration';
import { Goal } from './parser/gnumake';
import { DebugNow, frameworks_support, defaultSetupCommands } from './debugnow';
import { extension } from './extension';

console.log("DebugNow is:", DebugNow);

export class CppDbg extends DebugNow {
    constructor(log: Goal | undefined, goal: Goal, public testEnv?: TestEnvironment) {
        super(log, goal, testEnv);
        this.type = "cppdbg";
        this.environment = [{
            name: "srcdir",
            value: path.join(goal.make.ctx.fc.folder.uri.path, goal.make.dir)
        }];
        this.setupCommands = defaultSetupCommands;

        const gdb='gdb';
        this.program = goal.getFilePath();
        this.args = [];
        if (goal.flags & Goal.Flags.Libtool_Linked) {
            let libtool = path.join(goal.make.ctx.root, 'libtool');
            this.miDebuggerPath = extension.ltLauncher;
            this.miDebuggerArgs = `${gdb} ${libtool} ${this.program}`;
            this.MIMode = gdb;
            this.externalConsole = false;
        } else {
            this.miDebuggerPath = extension.integratedLauncher;
            this.miDebuggerArgs = `--mode-ad7 --debugger ${gdb} --debugee ${this.program}`;
            this.MIMode = gdb;
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

    }

    /* mi params used for debugging Libtool bins */
    program: string;
    args: string[];
    environment: { name: string, value: string }[];
    miDebuggerPath?: string;
    miDebuggerArgs?: string;
    MIMode?: string;
    additionalSOLibSearchPath?: string;
    externalConsole?: boolean;
    setupCommands: { description: string, text: string, ignoreFailures: boolean }[];
}

