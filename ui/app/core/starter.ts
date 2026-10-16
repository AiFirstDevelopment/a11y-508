import { Injectable, signal } from '@angular/core';

// Requests between the parts of the shell: the setup dialog (a first visit, nothing to crawl yet, or
// Change folder or URL on Diagnostics) and the folder picker (Browse… in the setup form).
@Injectable({ providedIn: 'root' })
export class Starter {
  // Asks the folder picker to open (Browse… in Set up), and whether it is open (aria-expanded).
  readonly browseRequests = signal(0);
  readonly pickerOpen = signal(false);
  // Asks the shell to open the setup dialog.
  readonly setupRequests = signal(0);

  openSetup(): void {
    this.setupRequests.update((n) => n + 1);
  }
}
