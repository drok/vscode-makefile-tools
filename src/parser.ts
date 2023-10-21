// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Interfaces that are shared among all parser types are defined here
 */

/* Each parser takes one line of input, and returns an array of 0, 1 or 2 Parsers:
   this = next line should be fed to this
   new Parser = next line should be fed to the new Parser.
   undefined = parsing this section has ended.
 */
   export enum ParserDisp {
    Continue,
    Enter,
    Leave,
}
export interface Parser {
    // On ingesting a new line, a Parser retuns a disposition (Enter, Leave or Continue),
    // and a target parser.
    // Embedded subsections:
    // To call a new subsection, return [Enter, new SectionParser]
    // To return from a subsection to the upper parser, return [Leave, this]
    // Array of sections:
    // At the end of a subsection, push() it to the parent
    // To end the current section, followed by another section, return [Continue, new SectionParser]
	ingest (line: string) : [
        ParserDisp,
        Parser
    ];
    // Push is called then a subsection is ended
    // If it returns this, the parent will be called on the next line
    // if it returns undefined, the parent will pushed, and the stack will be popped
    // until a parent is found that returns this (ie, wants to continue at the next line)
    push (sub: Parser) : Parser | undefined;
}

export class EmptyLine implements Parser {
    constructor(then: Parser) { this.then = then; }
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "")
            return [ParserDisp.Continue, this.then];
        throw new Error(`Unexpected line ${line}`);
    }
    push(sub: Parser) { return undefined; }
    then: Parser;
}

