import { Component } from '@angular/core';

// One item's detail page, /items/:id (docs/plans/manual-crawl-first.md AC 5): the photo has no text alternative.
@Component({
  selector: 'app-item',
  template: `<h1>Item</h1><img id="item-photo" src="/logo.png" width="120" height="60"> <p>One item of the catalogue.</p>`,
})
export class ItemComponent {}
