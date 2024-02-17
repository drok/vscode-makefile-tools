// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import { TestEnvironment, traits } from '../configuration';
import * as logger from '../logger';
import * as make from '../make';
import * as util from '../util';
import * as vscode from 'vscode';
import * as path from 'path';
import {Parser, ParserDisp, EmptyLine } from '../parser';
import { Executing } from './shell';
import { Node, Scheme } from '../tree';

import * as nls from 'vscode-nls';
import { Extension, extension, telemetry } from '../extension';
import { Span } from '@opentelemetry/api';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const chunkSize: number = 100;

enum MakeSection {
    Starting, /* pre Entering directory */
    Making, /* update target... */
    Copyright, /* # GNU make 4.1 ... */
    Database, /* --print-data-base dump */
    Padding, /* Extra output I don't care about */
}
export const EnteringRE = /^# make(?:\[\d+\])?: Entering directory '(.*)'$/;
const LeavingRE = /^# make(?:\[\d+\])?: Leaving directory '(.*)'$/;
const NothingRE = /^make(?:\[\d+\])?: Nothing to be done for '(.*)'\.$/;
export const ExecutingRE = /^(<builtin>|(.+):(\d+)): (?:update target '(.*)' due to: (?:.*)|target '(.*)' does not exist)$/;
const UptodateRE = /^make(?:\[\d+\])?: '(.*)' is up to date\.$/;
export const CopyrightRE = /^# (?:GNU Make|Mergesium Dry-Runner)/;
const RecursingRE = /^Making (.*) in (.*)$/;
/**
 * Parse the stdout of a GNU make run, and expect a Dumped database,
 * directory entry/leaving trace messages, and expanded shell fragments would
 * be run when building the targets.
 * Calls Database, Executing parser to extract info about the current makefile,
 * and Make to parse submake output.
 */
export class Make implements Parser {
    constructor(public dir: string, public span: Span, public root: string)
    {
        // this.dir = path.relative(root, dir);
        this.section = MakeSection.Starting;
        if (root) {
            let foundGoals = configuration.getAllBuildTargets().get(this.dir);
            if (foundGoals) {
                this.goals = foundGoals;
            } else {
                this.goals = new Map<string, Goal>();
                configuration.getAllBuildTargets().set(this.dir, this.goals);
            }
        } else this.goals = new Map<string, Goal>();
    }
    static makeArgs(): string[] { return [
        // take precedence over other parallel executions
        // specified in makefiles
        "-j1", "--output-sync=none",
        "--print-directory",
        // automake makefiles don't rely on builtin rules, so this makes the evaluation
        // a little faster, but the user could force custom rules which do rely on
        // builtin rules. If this is the case, the build be evaluated unexpectedly.
        // Relying on builtin rules would make the config non-portable, as it would need
        // GNU make.
        // TODO: How to tell the user his config is non-portable? Maybe allow a setting
        // "Allow non-portable config" ?
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        switch (this.section) {
            case MakeSection.Database:
                this.section = MakeSection.Padding;
                /* intentional fall-through, allows leaving immediately past Database */
            case MakeSection.Padding:
                let finished = DatabaseFinishedRE.test(line);
                if (finished) {
                    this.section = MakeSection.Making;
                    return [ParserDisp.Continue, this];
                }
            break;
            case MakeSection.Starting:
                this.section = MakeSection.Making;
                /* intentional fall-through */
            case MakeSection.Making:
                let leaving = LeavingRE.test(line);
                if (leaving) {
                    return [ParserDisp.Leave, this];
                }
                let executing = ExecutingRE.exec(line);
                if (executing) {
//                    if (this.file == "config.status" && false) { // FIXME: implement recursive detection. a single refresh is ok if configure.ac is newer
//                        // For some reason, reconfig was triggerred, meaning
//                        // --dry-run was not respected. Abort. this is a bug.
//                        throw new Error(`Unexpected reconfig in Make ${this.dir}. This is a bug.`);
//                    }
                    this.startExecuting(executing);
                    return [ParserDisp.Enter, new Executing(this)];
                }
                let uptodate = UptodateRE.exec(line);
                if (uptodate)
                    return [ParserDisp.Continue, this];
                let nothing = NothingRE.test(line);
                if (nothing)
                    return [ParserDisp.Continue, this];
                let entering = EnteringRE.exec(line);
                if (entering) { // This should only happen once at the top of the stack
                    // this.section = MakeSection.Making;
                    // This is not a hack: make in a deeper dir could call a shallow dir.
                    // That should be a new make, because it's at a different depth/dependency path
                    return this.enter(entering[1]);
                }
                let copyright = CopyrightRE.test(line);
                if (copyright) {
                    this.section = MakeSection.Copyright;
                    return [ParserDisp.Continue, this];
                }
                break;
            case MakeSection.Copyright:
                let database = DatabaseRE.test(line);
                if (database) {
                    this.section = MakeSection.Database;
                    return [ParserDisp.Enter, new EmptyLine(new Database(this))];
                }
                break;
        }
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) : Parser | undefined {
        if (sub instanceof Database) {
            let targets = configuration.getAllBuildTargets();
            // FIXME: GNU make enters several times the same directory during --dry-run
            // Can the work of parsing additional enterings be avoided?
            // only save data for the all-recursive target
            if (!targets.has(this.dir) || true) {
                targets.set(this.dir, sub.make.goals);
                // this.goals = sub.make.goals;
                this.test_suite = sub.test_suite;
                sub.variables.some((v) => {
                    if (v.variable)
                    switch (v.variable.name) {
                        case "CONFIG_HEADER":
                            // Targets with spaces in their names are not supported
                            // because make doesn't support them, at least not without
                            // significant song and dance. If you need to support
                            // tests with spaces in their names, please send PR.
                            this.config_header = new Set(v.variable.value.split(' '));
                            return true;
                        case "TESTS_ENVIRONMENT":
                            traits.overrides_TESTS_ENVIRONMENT = true;
                            logger.message(`WARN: ${this.dir} Makefile overrides ${v.variable.name} with '${v.variable.value}'`, 'Normal');
                            break;
                        default:
                            if (v.variable.name.endsWith("LOG_DRIVER")) {
                                if (v.variable.value != '$(SHELL) $(top_srcdir)/test-driver' && v.variable.value != '$(SHELL) $(top_srcdir)/build-aux/test-driver') {
                                    /* Customized test driver. */
                                    logger.message(`WARN: ${this.dir} uses ${v.variable.name}=${v.variable.value}; ${Extension.whoami} will override it.`, 'Normal');
                                    telemetry.logEvent(this.span, "warn-log-driver", {n: v.variable.name, v: v.variable.value}, true);
                                }
                                if (v.variable.name != "LOG_DRIVER") // This is overriden by default
                                    traits.log_drivers.add(v.variable.name);
                            }
                    }
                    return false;
                });
                /* Copy the Bin_test flag for logs that are generated by built tests
                 * and attach the built test as a depend, so it can be run under the debugger
                 */
                if (this.test_suite && this.test_suite.depends) {
                    this.test_suite.depends = this.test_suite.depends.map((d) => {
                        if (!d.goal) return d;
                        let n = this.goals.get(d.goal);
                        return n || d;
                    });
                }

                // Replace the test programs with build targets if known
                for (let g of this.goals.values()) {
                    if ((g.flags & Goal.Flags.Test_Log) && g.depends && g.depends[0].goal) {
                        let d = this.goals.get(g.depends[0].goal);
                        if (d) {
                            g.depends=[d];
                        }
                    }
                }
            }
            return this;
        } else if (sub instanceof Make) {
            if (this == sub)
                return this;
//                throw new Error(`Unexpected push in Make ${sub}`);
            if (sub.dir == this.dir) {
                logger.message(`ERROR: Unexpected make @ ${sub.dir} is a dependency of two targets: ${this.file} and ${sub.file} called from different hierarchical depths`);
                telemetry.logException(new Error(`make-multi-depth ${this.file} and ${sub.file}`), this.span);
            } else
                this.submake.set(sub.dir, sub);
            return this;
        } else if (sub instanceof Executing) {
            if (this.section == MakeSection.Copyright) {
                // Do something about the collected command lines?
                // this.section == Copyright if Executing found the copyright. Ie,
                // Executions are complete.
                return this;
            }
            return new Executing(this);
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in Make ${sub}`);
    }
    enter(dir: string) : [ParserDisp, Parser] {
        let reldir = path.relative(this.root, dir);
        return [ParserDisp.Enter, reldir == this.dir ? this : new Make(reldir, this.span, this.root)];
    }
    public getFile(): string | undefined {
        return this.file;
    }
    public getDir(): string {
        return path.join(this.root, this.dir);
    }
    public finish(): void { this.section = MakeSection.Copyright; }
    public startExecuting(rea: RegExpExecArray) {
        if (rea[1] === "<builtin>" && !make.builtin_targets.has(this.dir + "/" + rea[4])) {
            logger.message(localize("gnumake.warn.builtin.rule",
                "WARN: Built-in rules used for {0} in {1}, potentially with unexpected/incomplete FLAGS. see https://autotools.mergesium.com/doc/builtin-rules",
                rea[4], this.dir));
            make.builtin_targets.add(this.dir + "/" + rea[4]);
        }
        this.file = rea[4] ?? rea[5];
    }
    section: MakeSection;
    file: string | undefined;
    goals: Map<string,Goal>;
    config_header: Set<string> | undefined;
    submake: Map<string, Make> = new Map();
    /* builtins set prevents the same builtin warning to be printed multiple times */
    test_suite: Goal | undefined;
    hasStats?: boolean;
    stats: {
        tests: number;
        programs: number;
        subdirs: number;
        checks: number;
    } = {
        tests: 0,
        programs: 0,
        subdirs: 0,
        checks: 0
    };
}

const DatabaseRE = /^# Make data base, printed on (.*)$/;
const DatabaseFinishedRE = /^# Finished Make data base on (.*)$/;
const FilesRE = /^# Files$/;
const VariablesRE = /^# Variables$/;
/**
 * Parse a GNU make database dump to extract the list of build goals (targets)
 */
export class Database implements Parser {
    // constructor() { this.goals = []; }
    constructor (public make: Make) {
    }
    static makeArgs(): string[] { return [
        "--print-data-base",
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (FilesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Goal(this.make))];
        if (VariablesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Variable())];
        return [ParserDisp.Continue, this];
            // throw new Error(`Unexpected line ${line}`);
    }
    push(sub: Parser) {
        if (sub instanceof Goal) {
            if (!sub.goal) { /* End-of-goals, at # files hash-table stats */
                return undefined;
            } else {

                if (sub.flags & Goal.Flags.Test_Suite) {
                    this.test_suite = sub;
                }
                // binaries that follow a test suite are always test programs
                // TODO: check automake source code. is this guaranteed?
                if (this.test_suite && (sub.flags & Goal.Flags.Linked_binary))
                    sub.flags |= Goal.Flags.Test_Program;
                return new Goal(this.make); /* look for more Goals */
            }
        } else if (sub instanceof Variable) {
            if (!sub.flags) { /* End-of-variables */
                return sub;
            } else if (sub.variable) { /* gather only variables that were
                                        * interesting enough to collect */
                this.variables.push(sub);
            }
            return new Variable();
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in ${sub}`);
    }
    variables : Variable[] = [];
    test_suite : Goal | undefined;
}

// Lines which have variable content, but I don't need them
// const VariableMakefileRe = /^# makefile \(from '(.*)', line (\d+)\)$/;
const VariableFlagsRe = /^# (makefile|environment|automatic|default|command|'override'|variable)/;
const VariableDefinitionRe = /^(.*) = (.*)$/;
/**
 * Parse information about a single variable, differentiating makefile,
 * environment, default (:=), command line, 'override' directives
 * and automatic variables.
 */
export class Variable implements Parser {
    public static readonly Flags = {
        None: 0,
        /* Variable maked as "makefile" */
        makefile: 1,

        /* other variables */
        other: 2,
    };
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.variable)
                throw new Error("Unexpected end of variable");
            return [ParserDisp.Leave, this];
        } else {
            if (!this.flags) {
                let flags = VariableFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "variable":
                            if (line == '# variable set hash-table stats:')
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected variable line '${line}'`);
                        case "makefile":
                            this.flags |= Variable.Flags.makefile;
                            break;
                        default:
                            this.flags |= Variable.Flags.other;
                            break;
                    }
                } else
                    throw new Error(`Unexpected variable line '${line}'`);
                return [ParserDisp.Continue, this];
            }
            if (this.flags & Variable.Flags.makefile) {
                let variable = VariableDefinitionRe.exec(line);
                if (variable) {
                    switch (variable[1]) {
                        case "TESTS_ENVIRONMENT":
                        case "TESTS": this.variable = { name: variable[1], value: variable[2] }; break;
                        default:
                            if (variable[1].endsWith('LOG_DRIVER'))
                                this.variable = { name: variable[1], value: variable[2] }; break;
                    }
                }
            }
        }
        return [ParserDisp.Leave, this];
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    variable: { name: string, value : string } | undefined;
    flags: number = Goal.Flags.None;
}

const GoalInfoRe = /^#  (.*)$/;
// Lines which have variable content, but I don't need them
const GoalAckInfoRe = /^(?:Implicit\/static pattern stem:|Last modified)/;
const GoalVarsRe = /^# (?:automatic|. :=|variable set hash-table stats:|Load=)/;
const GoalFlagsRe = /^# (.*):$/;
const GoalRe = /^(.*): ?(.*)$/;
const AutomakePrimaryRe = /^(?:all|check|distcheck|install)$/;
const GNUMakeAuxiliaryRe = new RegExp('^\.(?:' +
    '(PHONY|SUFFIXES|PRECIOUS|NOEXPORT|MAKE)' +
    ')$');
/* Auxiliary goals are internally used by automake. They are dropped by the parser */
const AutomakeAuxRe = /(?:-recursive|-am|config.status|Makefile|stamp-h1|^am--.*|^\.deps\/.*|^\.DEFAULT|^\.obj|^\.c|^\.o|^\.c\.o|^\.c\.obj|^\.trs|^\.log\.trs|.*\.trs|depcomp|compile|missing|install-sh|Makefile.am)$/;
/* Noise targets are those a user most likely never wants to build from a gui */
const AutomakeNoiseRe = new RegExp('^(' +
    'ID|GTAGS|TAGS|CTAGS|tags|ctags|cscope|cscope\\.files|cscopelist|' +
    'installdirs|distcleancheck|distuninstallcheck|distdir|' +
    'mostlyclean|maintainer-clean-generic|mostlyclean-generic|clean-cscope|clean|' +
    'dist.*|uninstall-.*|install-.*|maintainer-.*|distclean-.*|installcheck|check-TESTS|' +
    'ps|html|pdf|clean-.*|info|mostlyclean|dvi|' +
    '(?:.*/)(?:\.|_)dirstamp|' +
//    '.*\\.o|.*\\.h|' +
    'Makefile.in)$');
const AutomakeTestLogRe = /^.*\.log$/;
const GoalRecipeRe = /^recipe to execute \((built-in|from '(.*)', line (\d+))\):/;
const GoalsEndRe = /^# files hash-table stats:$/;
const _empty = '';
/**
 * Parse information about a single goal, differentiating phony targets,
 * and expandable to handle other flags that Make keeps about each target
 * (eg, whether it is up-to-date). Calls the Recipe to parse the build recipe
 * if any.
 */
export class Goal extends Node implements Parser {
    public static readonly Flags = {
        None: 0,

        /* Flags gathered from Make (phony, etc) */
        Not_a_target: 8,

        /* Well-known automake targets */
        Automake_primary: 16,
        Automake_auxiliary: 32,
        Automake_noise: 64,


        /* Flags gathered from automake (recipe hints like $(LINK) */
        Dependency : 128,
        Linked_binary: 256,
        Test_Suite: 1024,
        Test_Program: 2048,
        Test_Log: 4096,
    };
    public trs?: make.TestResult;

    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.goal)
                throw new Error("Unexpected end of goal");
            return [ParserDisp.Leave, this];
        } else {
            if (!this.goal) {
                let flags = GoalFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "Not a target":
                            this.flags |= Goal.Flags.Not_a_target;
                            return [ParserDisp.Continue, this];
                        default:
                            if (GoalsEndRe.test(line))
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected Goal Flags ${flags[1]}`);
                        }
                }
            } else {
                let info = GoalInfoRe.exec(line);
                if (info) {
                    switch (info[1]) {
                        case "Command line target.":
                            return [ParserDisp.Continue, this];
                        case "Failed to be updated.":
                            /* FIXME: This should be handled */
                            return [ParserDisp.Continue, this];
                        case "Builtin rule":
                            /* FIXME: Should warn user of non-portable if builtins are used */
                            return [ParserDisp.Continue, this];
                        default:
                            if(GoalAckInfoRe.test(info[1]))
                                return [ParserDisp.Continue, this];

                            let recipe = GoalRecipeRe.exec(info[1]);
                            if (recipe) {
                                if (this.goal)
                                    return [ParserDisp.Enter, new Recipe(this)];
                                else
                                    throw new Error(`Unexpected Recipe in ${recipe[2]}:${recipe[3]} before goal name`);
                            }
                            throw new Error(`Unexpected Goal Info ${info[1]}`);
                        }
                } else {
                    if(GoalVarsRe.test(line))
                        return [ParserDisp.Continue, this];
                }
            }
            let goal = GoalRe.exec(line);
            if (goal) {
                if (this.goal)
                    throw new Error("Unexpected multiple goals per Goal section");
                if (AutomakeAuxRe.test(goal[1]) || GNUMakeAuxiliaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_auxiliary;
                else if (AutomakePrimaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_primary;
                else if (AutomakeNoiseRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_noise;

                this.goal = goal[1];
                /* Record this goal on make's goal list */
                /* Don't store automake auxiliary targets, they are thus
                 * unavailable for target selection
                 * Also skip noise targets because they are marginally useful, but
                 * nothing is implemented for them.
                 * Also skip not-targets (these are source files, not targets)
                 * Also skip targets without any flags
                 */
                if (!(this.flags & (Goal.Flags.Automake_auxiliary |
                    Goal.Flags.Not_a_target |
                    Goal.Flags.Automake_noise
                    )))
                    this.make.goals.set(this.goal, this);

                if (goal[2]) {
                    if (this.goal == "test-suite.log") {
                        this.flags |= Goal.Flags.Test_Suite;
                        this.depends = goal[2].split(' ')
                            .filter(s => s)
                            .map(s => this.getGoal(s, Goal.Flags.Test_Log));
                    } else if (AutomakeTestLogRe.test(goal[1])) {
                        this.flags |= Goal.Flags.Test_Log;
                        this.depends = goal[2].split(' ')
                            .map(s => this.getGoal(s, Goal.Flags.Test_Program));
                    } else if (!GNUMakeAuxiliaryRe.test(goal[1]) && !AutomakeAuxRe.test(goal[1]) && !AutomakeNoiseRe.test(goal[1])) {
                        this.flags |= Goal.Flags.Dependency;
                        this.depends = goal[2].split(' ')
                            .filter(s => s && 
                                !AutomakeNoiseRe.test(s) && 
                                !AutomakeAuxRe.test(s) &&
                                    (!path.isAbsolute(s) || // This includes builddir files (relative)
                                        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(s))))
                            // MUST filter on workspace|builddir files. This list contains /usr/include files
                            .map(s => this.getGoal(s, Goal.Flags.Dependency));
                    }

                } else if (!this.flags) {
                    // .test.log: (ie, implicit rules)
                    this.flags |= Goal.Flags.Automake_noise;
                }
                return [ParserDisp.Continue, this];
            }
        }
        throw new Error(`Unexpected Goal line ${line}`);
    }
    getGoal(s: string, flags: number = Goal.Flags.None) : Goal {
        let norms = path.normalize(s);
        let known = this.make.goals.get(norms);
        if (!known) {
            let newGoal = new Goal(this.make, norms, flags);
            this.make.goals.set(norms, newGoal);
            return newGoal;
        }
        known.flags |= flags;
        return known;
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    getChildren(): Node[] {
        if ((this.flags & Goal.Flags.Test_Suite)) {
            return this.depends ?? []
        }
        else
            return [];
    }
    getTreeItem(): vscode.TreeItem {
        if (!this.goal)
            throw new Error("Unexpected null goal");
        let item = new vscode.TreeItem(this.goal);
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.tooltip = this.goal;
        item.contextValue = ["nodeType=task"]
            .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=build'] : [])
            .concat((this.flags & Goal.Flags.Test_Log) ? ['nodeType=test'] : [])
            .concat((this.flags & Goal.Flags.Test_Log) &&
                (this.depends && (this.depends[0].flags & Goal.Flags.Linked_binary)) ? ['nodeType=bintest'] : [])
            .join(',');
        if (!this.task)
            return item;

        if (this.flags & Goal.Flags.Test_Log) {
            item.contextValue = (this.depends && (this.depends[0].flags & Goal.Flags.Linked_binary)) ?
                'nodeType=task,nodeType=test,nodeType=bintest' :
                'nodeType=task,nodeType=test';
            item.resourceUri = this.getURI();
            extension._projectTestSuitesProvider.all.set(item.resourceUri.path, this);
            item.id = item.resourceUri.path;
            // item.id = this.getFilePath();
        } else
        if (this.flags & Goal.Flags.Test_Suite) {
            item.description = this.make.stats.tests ?
                localize("autotools.subnode.suite", "{0} tests", this.make.stats.tests) : undefined;
            item.tooltip =  this.make.dir;
            // must satisfy the isURI test otherwise it is reallocated and the refernce won't
            // match in privideFileDecoration.
            // test is at https://github.com/microsoft/vscode/blob/main/src/vs/base/common/uri.ts#L98
            item.resourceUri = this.getURI();
            item.id = item.resourceUri.path;
        } else
        if (this.flags & Goal.Flags.Linked_binary) {
            item.resourceUri = this.getURI();
            extension._projectOutlineProvider.all.set(item.resourceUri.path, this);
            item.contextValue = 'nodeType=task,nodeType=build';
            item.id = item.resourceUri.path;
            // item.id = this.getFilePath();
        }
        return item;
    }
    getURI() : vscode.Uri {
        if (this.flags & (Goal.Flags.Test_Suite | Goal.Flags.Test_Log))
            return vscode.Uri.from({
                scheme: (this.flags & Goal.Flags.Test_Suite) ? Scheme.Check : Scheme.Test,
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
        else if (this.flags & (Goal.Flags.Linked_binary))
            return vscode.Uri.from({
                scheme: Scheme.Bin,
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
        else
            return vscode.Uri.from({
                scheme: "file",
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
    }
    getFilePath() : string {
        return path.isAbsolute(this.goal!) ?
            this.goal! :
            // Normalize because goals in the srcdir are refered to as /proj/src/blah/../file.c
            // when building in src/blah with source ${top_srcdir}/file.c (ie, "../file.c")
            util.resolvePathToRoot(path.normalize(path.join(configuration.getCurrentMakefileConfiguration().top_builddir, this.make.dir,this.goal!)));
    }
    getURIPath() : string {
        return path.isAbsolute(this.goal!) ?
            this.goal! :
            (this.flags & (Goal.Flags.Test_Suite | Goal.Flags.Test_Log)) ?
            path.join(configuration.getBuildEnvPath(),this.make.dir,this.goal!) :
            // Normalize because goals in the srcdir are refered to as /proj/src/blah/../file.c
            // when building in src/blah with source ${top_srcdir}/file.c (ie, "../file.c")
            util.resolvePathToRoot(path.normalize(path.join(configuration.getCurrentMakefileConfiguration().top_builddir, this.make.dir,this.goal!)));
    }

    logfile(): string | undefined {
        return this.test?.id;
    }

    constructor(public make: Make, public goal: string | undefined = undefined,
        public flags: number = Goal.Flags.None) {
        super();
        /* TODO: Implement check-local suite (eg, gnumake)
        if (goal == 'check-local')
            traits.has_local_suite = true;
        */
    }
    depends: Goal[] | undefined = undefined;
    livetask: Map<TestEnvironment,vscode.Task> | undefined;
    task: vscode.Task | Map<TestEnvironment,vscode.Task> | undefined;
    test: vscode.TestItem | undefined;
}

const LinkerRe = /\$\(\w*LINK\)\s/;
const RanlibRe = /\$\(RANLIB\)\s/;
const TestRe = /\$\(AM_TESTS_FD_REDIRECT\)\s/;
/**
 * Parse an unexpanded build recipe for a target.
 * Currently no information is captured, but it could be used to learn
 * what kind of target it is (eg, if `@ref $(LINK)` or `$(COMPILE)` is referenced
 */
export class Recipe implements Parser {
    constructor(goal: Goal) { this.goal = goal; }
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "")
            return [ParserDisp.Leave, this];
        if (LinkerRe.test(line)) {
            this.goal.flags |= Goal.Flags.Linked_binary;
        }
        if (TestRe.test(line))
            this.goal.flags |= Goal.Flags.Test_Log;
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
    goal: Goal;
}
