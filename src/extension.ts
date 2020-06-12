"use strict";

import { execFile } from "child_process";
import { homedir } from "os";
import * as vscode from "vscode";
import {
  Diagnostic,
  DocumentFormattingEditProvider,
  DocumentRangeFormattingEditProvider,
  ExtensionContext,
  Range,
  TextDocument,
  TextEdit,
  Uri,
  WorkspaceFolder,
} from "vscode";

/**
 * Activate this extension.
 *
 * Install a formatter for fish files using fish_indent, and start linting fish
 * files for syntax errors.
 *
 * Initialization fails if Fish is not installed.
 *
 * @param context The context for this extension
 * @return A promise for the initialization
 */
export const activate = async (context: ExtensionContext): Promise<any> => {
  startLinting(context);
};

/**
 * Start linting Fish documents.
 *
 * @param context The extension context
 */
const startLinting = (context: ExtensionContext): void => {
  const diagnostics = vscode.languages.createDiagnosticCollection(
    "bash",
  );
  context.subscriptions.push(diagnostics);

  const lint = async (document: TextDocument) => {
    if (isSavedBashDocument(document)) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      try {
        const result = await runInWorkspace(workspaceFolder, [
          "bash",
          "-n",
          document.fileName,
        ]);
        var d = bashOutputToDiagnostics(document, result.stderr);
      } catch (error) {
        vscode.window.showErrorMessage(error.toString());
        diagnostics.delete(document.uri);
        return;
      }
      diagnostics.set(document.uri, d as Diagnostic[]);
    }
  };

  vscode.workspace.onDidOpenTextDocument(lint, null, context.subscriptions);
  vscode.workspace.onDidSaveTextDocument(lint, null, context.subscriptions);
  vscode.workspace.textDocuments.forEach(lint);

  // Remove diagnostics for closed files
  vscode.workspace.onDidCloseTextDocument(
    (d) => diagnostics.delete(d.uri),
    null,
    context.subscriptions,
  );
};

/**
 * Parse bash errors from bash output for a given document.
 *
 * @param document The document to whose contents errors refer
 * @param output The error output from bash.
 * @return An array of all diagnostics
 */
const bashOutputToDiagnostics = (
  document: TextDocument,
  output: string,
): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<Diagnostic> = [];
  const matches = getMatches(/^(.+) \(line (\d+)\): (.+)$/gm, output);
  for (const match of matches) {
    const fileName = match[1];
    const lineNumber = Number.parseInt(match[2]);
    const message = match[3];

    if (expandUser(fileName).toString !== document.uri.toString) {
      continue;
    }

    const range = document.validateRange(
      new Range(lineNumber - 1, 0, lineNumber - 1, Number.MAX_VALUE),
    );
    const diagnostic = new Diagnostic(range, message);
    diagnostic.source = "bash";
    diagnostics.push(diagnostic);
  }
  return diagnostics;
};

/**
 * Whether a given document is saved to disk and in bash language.
 *
 * @param document The document to check
 * @return Whether the document is a bash document saved to disk
 */
// TODO: support bash vs zsh
const isSavedBashDocument = (document: TextDocument): boolean =>
  !document.isDirty &&
  0 <
    vscode.languages.match(
      {
        language: "shellscript",
        scheme: "file",
      },
      document,
    );

/**
 * Expand a leading tilde to $HOME in the given path.
 *
 * @param path The path to expand
 */
const expandUser = (path: string): Uri =>
  Uri.file(path.replace(/^~($|\/|\\)/, `${homedir()}$1`));

/**
 * A system error, i.e. an error that results from a syscall.
 */
interface ISystemError extends Error {
  readonly errno: string;
}

/**
 * Whether an error is a system error.
 *
 * @param error The error to check
 */
const isSystemError = (error: Error): error is ISystemError =>
  (error as ISystemError).errno !== undefined &&
  typeof (error as ISystemError).errno === "string";

/**
 * A process error.
 *
 * A process error occurs when the process exited with a non-zero exit code.
 */
interface IProcessError extends Error {
  /**
   * The exit code of the process.
   */
  readonly code: number;
}

/**
 * Whether an error is a process error.
 */
const isProcessError = (error: Error): error is IProcessError =>
  !isSystemError(error) &&
  (error as IProcessError).code !== undefined &&
  (error as IProcessError).code > 0;

/**
 * The result of a process.
 */
interface IProcessResult {
  /**
   * The integral exit code.
   */
  readonly exitCode: number;
  /**
   * The standard output.
   */
  readonly stdout: string;
  /**
   * The standard error.
   */
  readonly stderr: string;
}

/**
 * Run a command in a given workspace folder.
 *
 * If the workspace folder is undefined run the command in the working directory
 * if the vscode instance.
 *
 * @param folder The folder to run the command in
 * @param command The command array
 * @param stdin An optional string to feed to standard input
 * @return The result of the process as promise
 */
const runInWorkspace = (
  folder: WorkspaceFolder | undefined,
  command: ReadonlyArray<string>,
  stdin?: string,
): Promise<IProcessResult> =>
  new Promise((resolve, reject) => {
    const cwd = folder ? folder.uri.fsPath : process.cwd();
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd },
      (error, stdout, stderr) => {
        if (error && !isProcessError(error)) {
          // Throw system errors, but do not fail if the command
          // fails with a non-zero exit code.
          console.error("Command error", command, error);
          reject(error);
        } else {
          const exitCode = error ? error.code : 0;
          resolve({ stdout, stderr, exitCode });
        }
      },
    );
    if (stdin && child.stdin) {
      child.stdin.end(stdin);
    }
  });

/**
 * Exec pattern against the given text and return an array of all matches.
 *
 * @param pattern The pattern to match against
 * @param text The text to match the pattern against
 * @return All matches of pattern in text.
 */
const getMatches = (
  pattern: RegExp,
  text: string,
): ReadonlyArray<RegExpExecArray> => {
  const results = [];
  // We need to loop through the regexp here, so a let is required
  let match = pattern.exec(text);
  while (match !== null) {
    results.push(match);
    match = pattern.exec(text);
  }
  return results;
};
