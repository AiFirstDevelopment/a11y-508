import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EnvStore } from '../core/env.store';
import { DECISION_WORDS, ReviewService, decisionLine, routeOf } from '../core/review.service';
import { DecisionStatus, ReviewItem, ReviewList } from '../core/types';

// One finding that needs a person: what to check, where to look, and their decision.
@Component({
  selector: 'app-review-card',
  template: `
    @let f = item();
    <section class="review-card" [attr.aria-labelledby]="id + '-h'" data-testid="review-card" [attr.data-fingerprint]="f.fingerprint" [attr.data-status]="f.status">
      <h3 [id]="id + '-h'">{{ f.test }} {{ f.name }}: {{ f.message }}</h3>
      <p class="hint">WCAG {{ f.wcag }} · {{ f.impact }} · round {{ f.round }}@if (f.attempts) { · {{ f.attempts }} fix attempt{{ f.attempts === 1 ? '' : 's' }}}</p>

      <h4>What to check</h4>
      @if (f.condition) { <p data-testid="review-condition">{{ f.condition }}</p> }
      <p data-testid="review-message">{{ f.message }}</p>
      @if (f.reason) { <p class="hint" data-testid="review-reason">Why it needs a person: {{ f.reason }}</p> }

      <h4>Where to look</h4>
      @if (f.wholePage) { <p data-testid="whole-page"><strong>Whole page</strong>: the finding is about the page as a whole, not one element.</p> }
      <p class="label">{{ f.pages.length === 1 ? 'Page' : 'Pages (' + f.pages.length + ')' }}</p>
      <ul class="review-pages" data-testid="review-pages">
        @for (p of f.pages.slice(0, 20); track p) {
          @let r = route(p);
          <li><a [href]="p" target="_blank" rel="noopener" data-testid="review-page" [attr.data-url]="p">{{ r.path }}@if (r.query) {<span class="query" [attr.title]="p">?…</span>}<span class="visually-hidden"> (opens in a new tab)</span></a></li>
        }
        @if (f.pages.length > 20) { <li class="hint">and {{ f.pages.length - 20 }} more</li> }
      </ul>
      @if (!f.wholePage) {
        @if (f.screenshot) {
          <img data-testid="review-screenshot" [src]="f.screenshot" [alt]="'Screenshot of the element ' + f.selector" />
        } @else {
          <p data-testid="no-screenshot">No screenshot{{ f.screenshotMissing ? ' (the file is no longer in the report folder)' : '' }}.</p>
        }
      }
      <dl>
        @if (f.selector) { <dt>Selector</dt><dd><code data-testid="review-selector">{{ f.selector }}</code></dd> }
        @if (f.frame) { <dt>Frame</dt><dd><code>{{ f.frame }}</code></dd> }
        @if (f.html) { <dt>Rendered HTML</dt><dd><code data-testid="review-html">{{ f.html }}</code></dd> }
        <dt>Likely source files</dt>
        <dd>
          @if (f.sources.length) {
            <ul class="review-sources" data-testid="review-sources">
              @for (s of f.sources; track s.file + ':' + s.line) {
                <li><code data-testid="review-source">{{ s.file }}:{{ s.line }}</code> <span class="hint">has {{ s.kind === 'text' ? 'the text' : 'the ' + s.kind }} “{{ s.token }}”</span></li>
              }
            </ul>
          } @else {
            <span data-testid="no-sources">None of its markup was found under the source folders.</span>
          }
        </dd>
      </dl>

      <h4>Your decision</h4>
      @if (f.decision; as d) {
        <p data-testid="decision-line">{{ line(d) }}</p>
        @if (d.note) { <p class="hint" data-testid="decision-note">Your note: {{ d.note }}</p> }
      }
      <div class="field">
        <label [for]="id + '-note'">Note <span class="hint">(required for Won't fix; for the assistant when you ask it to fix this)</span></label>
        <textarea [id]="id + '-note'" #note rows="2" data-testid="decision-note-input" [attr.aria-describedby]="error() ? id + '-err' : null" [attr.aria-invalid]="error() ? 'true' : null"></textarea>
      </div>
      @if (error()) { <p class="notice error" role="alert" [id]="id + '-err'" data-testid="decision-error">{{ error() }}</p> }
      <div class="actions">
        @for (s of choices; track s) {
          <button type="button" [class.secondary]="s !== 'adequate'" [disabled]="busy()" (click)="choose(s)">{{ words[s] }}</button>
        }
      </div>
    </section>
  `,
})
export class ReviewCard {
  readonly item = input.required<ReviewItem>();
  readonly n = input.required<string>();
  readonly decided = output<{ item: ReviewItem; status: DecisionStatus }>();
  private review = inject(ReviewService);
  private note = viewChild.required<ElementRef<HTMLTextAreaElement>>('note');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly choices: DecisionStatus[] = ['adequate', 'wont-fix', 'open'];
  readonly words = DECISION_WORDS;
  readonly route = routeOf;
  readonly line = decisionLine;
  get id(): string {
    return `rv-${this.n()}`;
  }

  async choose(status: DecisionStatus): Promise<void> {
    const note = this.note().nativeElement.value.trim();
    this.error.set('');
    if (status === 'wont-fix' && !note) {
      this.error.set("Say why it won't be fixed in the note, then choose Won't fix again.");
      this.note().nativeElement.focus();
      return;
    }
    this.busy.set(true);
    try {
      await this.review.decide(this.item().fingerprint, status, note);
      this.decided.emit({ item: this.item(), status });
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}

// The findings the loop could not decide or gave up on, one card each, newest round first.
@Component({
  selector: 'app-review-screen',
  imports: [RouterLink, ReviewCard],
  template: `
    <p class="back"><a routerLink="/fix-loop">Back to Fix</a></p>
    <h1>Needs a person</h1>
    <p>The assistant could not decide these findings, or gave up on them. Each says what to check and where to look; your decision goes into the fix loop's ledger, and the loop follows it.</p>
    <p role="status" class="hint" data-testid="review-status">{{ status() }}</p>
    @if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
    @if (list(); as l) {
      @if (!l.exists) {
        <p data-testid="review-empty">The fix loop has not run in this folder yet, so nothing needs a person.</p>
      } @else {
        <h2 id="to-decide-h">To decide ({{ l.items.length }})</h2>
        @if (!l.items.length) { <p data-testid="review-empty">Nothing needs a person.</p> }
        @for (f of l.items; track f.fingerprint; let i = $index) {
          <app-review-card [item]="f" [n]="'d' + i" (decided)="onDecided($event)" />
        }
        @if (l.decided.length) {
          <h2 id="decided-h">Decided by you ({{ l.decided.length }})</h2>
          @for (f of l.decided; track f.fingerprint; let i = $index) {
            <app-review-card [item]="f" [n]="'x' + i" (decided)="onDecided($event)" />
          }
        }
      }
    } @else {
      <p role="status">Loading…</p>
    }
  `,
})
export class ReviewScreen {
  private review = inject(ReviewService);
  private env = inject(EnvStore);
  readonly list = signal<ReviewList | null>(null);
  readonly error = signal('');
  readonly status = signal('');
  readonly count = computed(() => this.list()?.items.length || 0);
  private loads = 0;

  constructor() {
    // Again whenever the working directory changes.
    effect(() => {
      this.env.cwd();
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    const n = ++this.loads;
    try {
      const l = await this.review.list();
      if (n === this.loads) this.list.set(l);
    } catch (e: any) {
      if (n === this.loads) this.error.set(e.message);
    }
  }

  async onDecided(e: { item: ReviewItem; status: DecisionStatus }): Promise<void> {
    this.status.set(`Recorded for ${e.item.test} “${e.item.message.slice(0, 80)}”: ${DECISION_WORDS[e.status]}.`);
    await this.load();
  }
}
