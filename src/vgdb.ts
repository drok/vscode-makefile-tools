import * as path from 'path';
import { TestEnvironment } from './configuration';
import { Goal } from './parser/gnumake';
import { DebugNow, frameworks_support, defaultSetupCommands } from './debugnow';
import { extension } from './extension';

export class VGdb extends DebugNow {
    constructor(log: Goal | undefined, goal: Goal, public testEnv?: TestEnvironment) {
        super(log, goal, testEnv);
        this.type = "vgdb";
        this.env = {
            srcdir: path.join(goal.make.ctx.fc.folder.uri.path, goal.make.dir)
        };
        this.startupCmds = defaultSetupCommands.map(v => v.text);
        const gdb='gdb';
        this.program = goal.getFilePath();
        this.debugger = extension.integratedLauncher;
        this.debuggerArgs = ['--mode-vgdb', '--debugger', gdb, '--debugee', goal.getFilePath() ];
        this.args = [];
        this.debug = 'basic';
        if (goal.flags & Goal.Flags.Libtool_Linked) {
            let libtool = path.join(goal.make.ctx.root, 'libtool');
            this.externalConsole = false;
        } else {
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
    }

    program: string;
    args: string[];
    env: { [key: string]: string };
    debug?: string;
    debugger?: string;
    debuggerArgs?: string[];
    externalConsole?: boolean;
    startupCmds?: string[];
}

