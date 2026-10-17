import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdminHomeComponent } from './admin-home.component';
import { AdminUsersComponent } from './admin-users.component';

const routes: Routes = [
  { path: '', component: AdminHomeComponent },
  { path: 'users', component: AdminUsersComponent },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class AdminModule {}
