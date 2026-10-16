import { Component } from '@angular/core';

@Component({
  selector: 'app-search-bar',
  template: `<form role="search" action="/search"><input id="q" name="q" aria-label="Search terms"> <button id="search-btn" class="icon-search" type="submit"><span class="magnifier"></span></button></form>`,
})
export class SearchBarComponent {}
