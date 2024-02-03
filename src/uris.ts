import { assert } from 'console';
import { Uri } from 'vscode';

export const SCHEME = 'autotools';

export const enum UriType {
	/** All console output for a task */
	TaskOutput,
	/** All console output for a test in a task */
	TestOutput,
	/** Specific message in a test */
	ResultMessage,
	/** Specific actual output message in a test */
	ResultActualOutput,
	/** Specific expected output message in a test */
	ResultExpectedOutput,
}

interface IAllOutputReference {
	type: UriType.TaskOutput;
	resultId: string;
	taskIndex: number;
}

interface IResultTestUri {
	resultId: string;
	taskIndex: number;
	testExtId: string;
}

interface ITestOutputReference extends IResultTestUri {
	type: UriType.TestOutput;
}

interface IResultTestMessageReference extends IResultTestUri {
	type: UriType.ResultMessage;
	messageIndex: number;
}

interface ITestDiffOutputReference extends IResultTestUri {
	type: UriType.ResultActualOutput | UriType.ResultExpectedOutput;
	messageIndex: number;
}

export type ParsedUri =
	| IAllOutputReference
	| IResultTestMessageReference
	| ITestDiffOutputReference
	| ITestOutputReference;

const enum TestUriParts {
    Test = 'test',
    Check = 'check',
    Build = 'build',
	Results = 'results',

	AllOutput = 'output',
	Messages = 'message',
	Text = 'TestFailureMessage',
	ActualOutput = 'ActualOutput',
	ExpectedOutput = 'ExpectedOutput',
}

export const parseUri = (uri: Uri): ParsedUri | undefined => {
	const type = uri.authority;
	const [resultId, ...request] = uri.path.slice(1).split('/');

	if (request[0] === TestUriParts.Messages) {
		const taskIndex = Number(request[1]);
		const testExtId = uri.query;
		const index = Number(request[2]);
		const part = request[3];
		if (type === TestUriParts.Results) {
			switch (part) {
				case TestUriParts.Text:
					return { resultId, taskIndex, testExtId, messageIndex: index, type: UriType.ResultMessage };
				case TestUriParts.ActualOutput:
					return { resultId, taskIndex, testExtId, messageIndex: index, type: UriType.ResultActualOutput };
				case TestUriParts.ExpectedOutput:
					return { resultId, taskIndex, testExtId, messageIndex: index, type: UriType.ResultExpectedOutput };
				case TestUriParts.Messages:
			}
		}
	}

	if (request[0] === TestUriParts.AllOutput) {
		const testExtId = uri.query;
		const taskIndex = Number(request[1]);
		return testExtId
			? { resultId, taskIndex, testExtId, type: UriType.TestOutput }
			: { resultId, taskIndex, type: UriType.TaskOutput };
	}

	return undefined;
};

export const buildUri = (parsed: ParsedUri): Uri => {
	const uriParts = {
		scheme: SCHEME,
		authority: TestUriParts.Results
	};

	if (parsed.type === UriType.TaskOutput) {
		return Uri.from({
			...uriParts,
			path: ['', parsed.resultId, TestUriParts.AllOutput, parsed.taskIndex].join('/'),
		});
	}

	const msgRef = (resultId: string, ...remaining: (string | number)[]) =>
		Uri.from({
			...uriParts,
			query: parsed.testExtId,
			path: ['', resultId, TestUriParts.Messages, ...remaining].join('/'),
		});

	switch (parsed.type) {
		case UriType.ResultActualOutput:
			return msgRef(parsed.resultId, parsed.taskIndex, parsed.messageIndex, TestUriParts.ActualOutput);
		case UriType.ResultExpectedOutput:
			return msgRef(parsed.resultId, parsed.taskIndex, parsed.messageIndex, TestUriParts.ExpectedOutput);
		case UriType.ResultMessage:
			return msgRef(parsed.resultId, parsed.taskIndex, parsed.messageIndex, TestUriParts.Text);
		case UriType.TestOutput:
			return Uri.from({
				...uriParts,
				query: parsed.testExtId,
				path: ['', parsed.resultId, TestUriParts.AllOutput, parsed.taskIndex].join('/'),
			});
		default:
			assert(parsed, 'Invalid test uri');
	}
    return Uri.from({
        scheme: "unknown",
        path: '/'
    });
};