import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormStore } from './form.store';
import { RunStore } from './run.store';
import { SignInFlow } from './sign-in';

// Starting a crawl, from Set up (the Start button, the setup dialog) and from Run again: the
// sign-in crawl in a fresh browser (--login --stay) unless a way in was chosen at /run/advanced,
// then the Crawl step.
@Injectable({ providedIn: 'root' })
export class Starter {
  private form = inject(FormStore);
  private run = inject(RunStore);
  private flow = inject(SignInFlow);
  private router = inject(Router);
  // Asks the header's folder picker to open (Browse… in Set up).
  readonly browseRequests = signal(0);

  // url: the start URL when the form has none (Run again from Fix uses the loop's).
  async startCrawl(url = ''): Promise<void> {
    if (!this.form.url().trim() && url) this.form.url.set(url);
    if (!this.form.authChosen()) {
      await this.flow.start();
    } else {
      this.form.rememberUrl();
      try {
        await this.run.start(this.form.body('crawl'));
      } finally {
        this.form.clearToken();
      }
    }
    await this.router.navigateByUrl('/live');
  }
}
