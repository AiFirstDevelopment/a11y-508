import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `<h1>Not found</h1><p>There is no such screen. <a routerLink="/run">Go to Run</a>.</p>`,
})
export class NotFoundScreen {}
