import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { EnvStore } from '../core/env.store';
import { localTime, savedAgo } from '../core/format';
import { RunStore } from '../core/run.store';
import { SignInFlow } from '../core/sign-in';

// The sign-in state line the Run and Fix loop screens share: Not signed in with
// Sign in; the wait while the window is open; Signed in · session saved … with
// Sign in again; a failed sign-in with Try again. Focus moves to the status when
// a sign-in ends.
@Component({
  selector: 'app-sign-in-state',
  template: `
    <div class="signin-state">
      <p role="status" id="signin-state" data-testid="signin-state" tabindex="-1" #signinState>
        @if (flow.active()) {
          A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.
        } @else if (flow.failed()) {
          <span class="err-text">Sign-in did not finish: {{ flow.error() }}</span>
        } @else if (signedIn()) {
          <span class="ok">Signed in · session saved {{ savedText() }} (<time [attr.datetime]="savedAt().iso" [attr.title]="savedAt().iso">{{ savedAt().local }}</time>)</span>
        } @else {
          Not signed in
        }
      </p>
      @if (!flow.active()) {
        @if (flow.failed()) {
          <button type="button" (click)="signIn()" [disabled]="!canSignIn()">Try again</button>
        } @else if (signedIn()) {
          <button type="button" class="link" (click)="signIn()" [disabled]="!canSignIn()">Sign in again</button>
        } @else {
          <button type="button" (click)="signIn()" [disabled]="!canSignIn()">Sign in</button>
        }
      } @else {
        <button type="button" class="secondary" (click)="run.stop()">Cancel sign-in</button>
      }
    </div>
    @if (error()) {
      <div class="notice error" role="alert" data-notice="signin-error">{{ error() }}</div>
    }
  `,
})
export class SignInState {
  // The URL to sign in on, and whether to follow the sign-in crawl on Live.
  readonly url = input('');
  readonly goLive = input(true);
  readonly flow = inject(SignInFlow);
  readonly run = inject(RunStore);
  private env = inject(EnvStore);
  private router = inject(Router);
  private statusEl = viewChild<ElementRef<HTMLElement>>('signinState');
  readonly error = signal('');
  readonly signedIn = computed(() => !!this.env.env()?.session?.exists || !!this.flow.saved());
  readonly savedText = computed(() => {
    const s = this.env.env()?.session;
    return s?.exists ? savedAgo(s.ageMs) : 'just now';
  });
  readonly savedAt = computed(() => {
    const s = this.env.env()?.session;
    const t = s?.exists && s.ageMs !== undefined ? new Date(Date.now() - s.ageMs) : new Date();
    return { iso: t.toISOString(), local: localTime(t) };
  });
  readonly canSignIn = computed(() => !!this.url().trim() && !this.run.active());

  constructor() {
    let wasActive = false;
    effect(() => {
      const active = this.flow.active();
      if (wasActive && !active) untracked(() => setTimeout(() => this.statusEl()?.nativeElement.focus()));
      wasActive = active;
    });
  }

  async signIn(): Promise<void> {
    if (!this.canSignIn()) return;
    this.error.set('');
    try {
      await this.flow.start(this.url().trim());
      // The crawl runs in the sign-in window; Live shows the wait, then the pages.
      if (this.goLive()) await this.router.navigateByUrl('/live');
    } catch (e: any) {
      this.error.set(e.message);
    }
  }
}
