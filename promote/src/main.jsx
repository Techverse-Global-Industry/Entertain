import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom';
import { Providers, Loading, ErrorState, useSession } from './lib';
import { Platform, Profile, BookPage, EventPage, EventsPage, GuestPage, LoginPage, JoinPage, InvitePage, SetupPage, WorkspacePicker } from './public';
import './styles.css';
import './themes.css';
import './sponsors.css';
import './professions.css';
import './site-flow.css';
const Dashboard = lazy(() => import('./dashboard'));
const Admin = lazy(() => import('./admin'));
const Delivery = lazy(()=>import('./client-deliveries').then(module=>({default:module.ClientDeliveryPage})));
class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render() { return this.state.error ? <div className="app-error"><ErrorState error="This page could not load. Your saved records are safe." retry={() => window.location.reload()}/></div> : this.props.children; }
}
function RootPage() { const { bootstrap, error } = useSession(); if (error) return <ErrorState error={error} retry={() => window.location.reload()}/>; if (!bootstrap) return <Loading/>; return bootstrap.tenant ? <Profile slugOverride={bootstrap.tenant.slug}/> : <Platform/>; }
function AppRoutes() {
  return <Suspense fallback={<Loading/>}><Routes>
    <Route path="/" element={<RootPage/>}/><Route path="/discover" element={<Platform discover/>}/>
    <Route path="/p/:slug" element={<Profile/>}/><Route path="/p/:slug/book" element={<BookPage/>}/>
    <Route path="/p/:slug/events" element={<EventsPage/>}/><Route path="/p/:slug/events/:eventId" element={<EventPage/>}/>
    <Route path="/book" element={<BookPage/>}/><Route path="/events" element={<EventsPage/>}/><Route path="/events/:eventId" element={<EventPage/>}/>
    <Route path="/manage/:kind/:id" element={<GuestPage/>}/><Route path="/login" element={<LoginPage/>}/>
    <Route path="/join" element={<JoinPage/>}/><Route path="/setup" element={<SetupPage/>}/><Route path="/invite/:token" element={<InvitePage/>}/>
    <Route path="/delivery/:deliveryId" element={<Delivery/>}/><Route path="/workspaces" element={<WorkspacePicker/>}/><Route path="/dashboard/:slug/:tab?" element={<Dashboard/>}/><Route path="/admin/:tab?" element={<Admin/>}/>
    <Route path="*" element={<div className="app-error"><ErrorState error="This page doesn’t exist. Check the address or return to the home page." retry={() => window.location.assign('/')}/></div>}/>
  </Routes></Suspense>;
}
createRoot(document.getElementById('root')).render(<Boundary><BrowserRouter><Providers><AppRoutes/></Providers></BrowserRouter></Boundary>);
