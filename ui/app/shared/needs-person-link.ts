import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

// One line on the Fix step and History: how many findings wait for a person, and the way to them.
@Component({
  selector: 'app-needs-person-link',
  imports: [RouterLink],
  template: `
    @if (count() > 0) {
      <p class="needs-person" data-testid="needs-person-link"><a routerLink="/review">{{ count() }} need{{ count() === 1 ? 's' : '' }} a person — review them</a></p>
    }
  `,
})
export class NeedsPersonLink {
  readonly count = input(0);
}
