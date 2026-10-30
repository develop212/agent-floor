// Chat panel for the Agent Floor. Lets a browser visitor type a prompt, the
// server streams the reply, and an agent desk appears on the floor while it
// works.

import { icon } from './icons';
import { el } from './hud';

/** Sends a prompt; `onDelta` is called with each streamed chunk. */
export type SendChat = (prompt: string, onDelta: (chunk: string) => void) => Promise<void>;

export class Chat {
  private root = el('section', 'chat glass');
  private header = el('div', 'chat-head');
  private title = el('h2', '', 'Web Chat');
  private closeBtn = el('button', 'chat-close', icon('x')) as HTMLButtonElement;
  private messages = el('div', 'chat-messages');
  private inputRow = el('div', 'chat-input-row');
  private input = el('textarea', 'chat-input') as HTMLTextAreaElement;
  private sendBtn = el('button', 'chat-send', icon('play')) as HTMLButtonElement;
  private status = el('div', 'chat-status', '');
  private open = false;
  private busy = false;

  constructor(private onSend: SendChat) {
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close chat');
    this.closeBtn.title = 'Close chat';
    this.closeBtn.addEventListener('click', () => this.toggle(false));

    this.sendBtn.type = 'button';
    this.sendBtn.setAttribute('aria-label', 'Send');
    this.sendBtn.addEventListener('click', () => this.send());

    this.input.rows = 2;
    this.input.placeholder = 'Type a design task...';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.header.append(this.title, this.closeBtn);
    this.inputRow.append(this.input, this.sendBtn);
    this.root.append(this.header, this.messages, this.inputRow, this.status);
  }

  get button() {
    const b = el('button', 'icon-btn chat-btn', icon('chat')) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-label', 'Chat with an agent');
    b.title = 'Chat (C)';
    b.addEventListener('click', () => this.toggle());
    return b;
  }

  get rootEl() {
    return this.root;
  }

  get isOpen() {
    return this.open;
  }

  toggle(force?: boolean) {
    this.open = typeof force === 'boolean' ? force : !this.open;
    this.root.classList.toggle('show', this.open);
    this.button.classList.toggle('active', this.open);
    if (this.open) this.input.focus();
  }

  private setStatus(text: string, isError = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', isError);
  }

  private bubble(cls: string) {
    const b = el('div', `chat-msg ${cls}`);
    this.messages.append(b);
    this.messages.scrollTop = this.messages.scrollHeight;
    return b;
  }

  private async send() {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.busy = true;
    this.sendBtn.disabled = true;
    this.setStatus('thinking...');
    this.bubble('user').textContent = text;
    const reply = this.bubble('assistant streaming');
    try {
      await this.onSend(text, (chunk) => {
        reply.textContent += chunk;
        this.messages.scrollTop = this.messages.scrollHeight;
      });
      this.setStatus('');
    } catch (err) {
      reply.textContent = err instanceof Error ? err.message : String(err);
      this.setStatus('failed', true);
    } finally {
      reply.classList.remove('streaming');
      this.busy = false;
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }
}
