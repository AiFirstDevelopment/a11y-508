import { Component } from '@angular/core';

@Component({
  selector: 'app-header',
  template: `<header><a href="/">Example app</a> <button id="menu-btn" class="icon-menu" type="button"><span class="bars"></span></button> <a href="/search">Search</a></header>`,
})
export class HeaderComponent {}
