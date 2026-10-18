import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SettingsHomeComponent } from './settings-home.component';
import { ProfileComponent } from './profile.component';

const routes: Routes = [
  { path: '', component: SettingsHomeComponent },
  { path: 'profile', component: ProfileComponent },
];

@NgModule({ imports: [RouterModule.forChild(routes)], exports: [RouterModule] })
export class SettingsRoutingModule {}
