/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as actions from './recorder/recorderActions';
import type * as channels from '../../protocol/channels';
import { CodeGenerator, ActionInContext } from './recorder/codeGenerator';
import { toClickOptions, toModifiers } from './recorder/utils';
import { Page } from '../page';
import { Frame } from '../frames';
import { BrowserContext } from '../browserContext';
import { LanguageGenerator } from './recorder/language';
import { JavaScriptLanguageGenerator } from './recorder/javascript';
import { CSharpLanguageGenerator } from './recorder/csharp';
import { PythonLanguageGenerator } from './recorder/python';
import { ProgressController } from '../progress';
import * as recorderSource from '../../generated/recorderSource';
import * as consoleApiSource from '../../generated/consoleApiSource';
import { FileOutput, FlushingTerminalOutput, OutputMultiplexer, RecorderOutput, TerminalOutput, Writable } from './recorder/outputs';

type BindingSource = { frame: Frame, page: Page };
type App = 'codegen' | 'debug' | 'pause';
type Mode = 'inspecting' | 'recording' | 'none';

const symbol = Symbol('RecorderSupplement');


export class RecorderSupplement {
  private _generator: CodeGenerator;
  private _pageAliases = new Map<Page, string>();
  private _lastPopupOrdinal = 0;
  private _lastDialogOrdinal = 0;
  private _timers = new Set<NodeJS.Timeout>();
  private _context: BrowserContext;
  private _resumeCallback: (() => void) | null = null;
  private _recorderState: { mode: Mode };
  private _paused = false;
  private _app: App;
  private _output: OutputMultiplexer;

  static getOrCreate(context: BrowserContext, app: App, params: channels.BrowserContextRecorderSupplementEnableParams): Promise<RecorderSupplement> {
    let recorderPromise = (context as any)[symbol] as Promise<RecorderSupplement>;
    if (!recorderPromise) {
      const recorder = new RecorderSupplement(context, app, params);
      recorderPromise = recorder.install().then(() => recorder);
      (context as any)[symbol] = recorderPromise;
    }
    return recorderPromise;
  }

  constructor(context: BrowserContext, app: App, params: channels.BrowserContextRecorderSupplementEnableParams) {
    this._context = context;
    this._app = app;
    this._recorderState = { mode: app === 'codegen' ? 'recording' : 'none' };
    let languageGenerator: LanguageGenerator;
    switch (params.language) {
      case 'javascript': languageGenerator = new JavaScriptLanguageGenerator(); break;
      case 'csharp': languageGenerator = new CSharpLanguageGenerator(); break;
      case 'python':
      case 'python-async': languageGenerator = new PythonLanguageGenerator(params.language === 'python-async'); break;
      default: throw new Error(`Invalid target: '${params.language}'`);
    }
    let highlighterType = params.language;
    if (highlighterType === 'python-async')
      highlighterType = 'python';

    const writable: Writable = {
      write: (text: string) => context.emit(BrowserContext.Events.StdOut, text)
    };
    const outputs: RecorderOutput[] = [params.terminal ? new TerminalOutput(writable, highlighterType) : new FlushingTerminalOutput(writable)];
    if (params.outputFile)
      outputs.push(new FileOutput(params.outputFile));
    this._output = new OutputMultiplexer(outputs);
    this._output.setEnabled(app === 'codegen');
    context.on(BrowserContext.Events.BeforeClose, () => this._output.flush());

    const generator = new CodeGenerator(context._browser._options.name, app === 'codegen', params.launchOptions || {}, params.contextOptions || {}, this._output, languageGenerator, params.device, params.saveStorage);
    this._generator = generator;
  }

  async install() {
    this._context.on('page', page => this._onPage(page));
    for (const page of this._context.pages())
      this._onPage(page);

    this._context.once('close', () => {
      for (const timer of this._timers)
        clearTimeout(timer);
      this._timers.clear();
    });

    // Input actions that potentially lead to navigation are intercepted on the page and are
    // performed by the Playwright.
    await this._context.exposeBinding('playwrightRecorderPerformAction', false,
        (source: BindingSource, action: actions.Action) => this._performAction(source.frame, action));

    // Other non-essential actions are simply being recorded.
    await this._context.exposeBinding('playwrightRecorderRecordAction', false,
        (source: BindingSource, action: actions.Action) => this._recordAction(source.frame, action));

    // Commits last action so that no further signals are added to it.
    await this._context.exposeBinding('playwrightRecorderCommitAction', false,
        (source: BindingSource, action: actions.Action) => this._generator.commitLastAction());

    await this._context.exposeBinding('playwrightRecorderState', false, () => {
      return {
        state: this._recorderState,
        app: this._app,
        paused: this._paused
      };
    });

    await this._context.exposeBinding('playwrightRecorderSetState', false, (source, state) => {
      this._recorderState = state;
      this._output.setEnabled(state.mode === 'recording');
    });

    await this._context.exposeBinding('playwrightRecorderResume', false, () => {
      if (this._resumeCallback) {
        this._resumeCallback();
        this._resumeCallback = null;
      }
      this._paused = false;
    });

    await this._context.extendInjectedScript(recorderSource.source);
    await this._context.extendInjectedScript(consoleApiSource.source);
  }

  async pause() {
    this._paused = true;
    return new Promise(f => this._resumeCallback = f);
  }

  private async _onPage(page: Page) {
    // First page is called page, others are called popup1, popup2, etc.
    const frame = page.mainFrame();
    page.on('close', () => {
      this._pageAliases.delete(page);
      this._generator.addAction({
        pageAlias,
        frame: page.mainFrame(),
        committed: true,
        action: {
          name: 'closePage',
          signals: [],
        }
      });
    });
    frame.on(Frame.Events.Navigation, () => this._onFrameNavigated(frame, page));
    page.on(Page.Events.Download, () => this._onDownload(page));
    page.on(Page.Events.Popup, popup => this._onPopup(page, popup));
    page.on(Page.Events.Dialog, () => this._onDialog(page));
    const suffix = this._pageAliases.size ? String(++this._lastPopupOrdinal) : '';
    const pageAlias = 'page' + suffix;
    this._pageAliases.set(page, pageAlias);

    const isPopup = !!await page.opener();
    // Could happen due to the await above.
    if (page.isClosed())
      return;
    if (!isPopup) {
      this._generator.addAction({
        pageAlias,
        frame: page.mainFrame(),
        committed: true,
        action: {
          name: 'openPage',
          url: page.mainFrame().url(),
          signals: [],
        }
      });
    }
  }

  private async _performAction(frame: Frame, action: actions.Action) {
    const page = frame._page;
    const controller = new ProgressController();
    const actionInContext: ActionInContext = {
      pageAlias: this._pageAliases.get(page)!,
      frame,
      action
    };
    this._generator.willPerformAction(actionInContext);
    if (action.name === 'click') {
      const { options } = toClickOptions(action);
      await frame.click(controller, action.selector, options);
    }
    if (action.name === 'press') {
      const modifiers = toModifiers(action.modifiers);
      const shortcut = [...modifiers, action.key].join('+');
      await frame.press(controller, action.selector, shortcut);
    }
    if (action.name === 'check')
      await frame.check(controller, action.selector);
    if (action.name === 'uncheck')
      await frame.uncheck(controller, action.selector);
    if (action.name === 'select')
      await frame.selectOption(controller, action.selector, [], action.options.map(value => ({ value })));
    const timer = setTimeout(() => {
      actionInContext.committed = true;
      this._timers.delete(timer);
    }, 5000);
    this._generator.didPerformAction(actionInContext);
    this._timers.add(timer);
  }

  private async _recordAction(frame: Frame, action: actions.Action) {
    // We are lacking frame.page() in
    this._generator.addAction({
      pageAlias: this._pageAliases.get(frame._page)!,
      frame,
      action
    });
  }

  private _onFrameNavigated(frame: Frame, page: Page) {
    const pageAlias = this._pageAliases.get(page);
    this._generator.signal(pageAlias!, frame, { name: 'navigation', url: frame.url() });
  }

  private _onPopup(page: Page, popup: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    const popupAlias = this._pageAliases.get(popup)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'popup', popupAlias });
  }
  private _onDownload(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'download' });
  }

  private _onDialog(page: Page) {
    const pageAlias = this._pageAliases.get(page)!;
    this._generator.signal(pageAlias, page.mainFrame(), { name: 'dialog', dialogAlias: String(++this._lastDialogOrdinal) });
  }
}

