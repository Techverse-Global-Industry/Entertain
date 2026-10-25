import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSiteFlow,withMainProfession} from '../shared/site-flow.mjs';
import {professionBlueprints} from '../shared/professions.mjs';

const next='2030-11-20T18:00:00.000Z',now=new Date('2026-10-24T12:00:00Z');
const fixture=(professions)=>({business:{name:'Test Studio',slug:'test-studio',email:'studio@test.example',professions,features:{showcase:true,music:true,tours:true,events:true,bookings:true,mediaKit:true},gallery:[]},services:professions.map(id=>({id:'service-'+id,category:id})),professional:{work:professions.map(id=>({id:'work-'+id,profession:id,published:true})),tracks:professions.filter(id=>professionBlueprints[id]?.modules.includes('audio')).map(id=>({id:'audio-'+id,profession:id,published:true})),audience:[{platform:'Test channel',followers:500}],profiles:{}},events:[{id:'event',kind:'event',startsAt:next},{id:'tour',kind:'tour',startsAt:next}]});

test('Each main profession leads with the content people visit it for',()=>{
  for(const [id,type] of Object.entries({mc:'work',dj:'audio',promoter:'events',organiser:'events',guide:'tours',creator:'work',musician:'audio',comedian:'work',photographer:'work',videographer:'work'})){const flow=buildSiteFlow(fixture([id]),[],now);assert.equal(flow.sections[0].type,type,id);assert.equal(flow.presentation.role.id,id);assert.equal(flow.hero.href,'#'+flow.sections[0].id);}
});

test('Combined professions preserve the main profession, expose each craft and avoid duplicate sections',()=>{
  const data=fixture(['mc','dj','guide','musician','creator']),flow=buildSiteFlow(data,[],now);assert.equal(flow.sections[0].profession,'mc');assert.equal(flow.sections.filter(section=>section.type==='audio').length,1);assert.equal(flow.sections.filter(section=>section.type==='services').length,1);assert(flow.navigation.some(item=>item.label==='Hosting'));assert(flow.navigation.some(item=>item.label==='Listen'));assert(flow.navigation.some(item=>item.label==='Tours'));assert(flow.navigation.some(item=>item.label==='Media kit'));assert.equal(new Set(flow.sections.map(section=>section.id)).size,flow.sections.length);
  const reordered=withMainProfession(data.business.professions,'guide');assert.deepEqual(data.business.professions,['mc','dj','guide','musician','creator']);data.business.professions=reordered;assert.equal(buildSiteFlow(data,[],now).sections[0].type,'tours');
});

test('Drafts, expired dates and disabled tools do not create public navigation or empty sections',()=>{
  const data=fixture(['dj','creator','guide']);data.business.features.music=false;data.business.features.mediaKit=false;data.business.features.tours=false;data.professional.work.forEach(item=>item.published=false);data.events[0].startsAt='2025-01-01T00:00:00.000Z';let flow=buildSiteFlow(data,[],now);assert.deepEqual(flow.sections.map(section=>section.type),['services']);assert.equal(flow.hero.label,'Book Test Studio');assert.deepEqual(flow.navigation.map(item=>item.label),['Services']);data.business.features.bookings=false;flow=buildSiteFlow(data,[],now);assert.equal(flow.sections.length,0);assert.equal(flow.hero.href,'mailto:studio@test.example');
});

test('Legacy photo galleries remain discoverable and single-role portfolios keep their own navigation',()=>{
  const data=fixture(['photographer']);data.professional.work=[];data.events=[];data.business.gallery=[{url:'/media/test.webp',caption:'Portfolio image'}];const flow=buildSiteFlow(data,[],now);assert.equal(flow.sections[0].type,'gallery');assert.equal(flow.hero.href,'#the-work');assert.equal(flow.hero.label,'View my photography');assert(!flow.navigation.some(link=>link.label==='Listen'||link.label==='Events'||link.label==='Tours'));
});

test('Custom professions inherit their chosen presentation and preserve their own name',()=>{
  const data=fixture(['radio-host']);data.professional.roles=[{id:'radio-host',name:'Radio Host',baseId:'dj'}];data.professional.tracks=[{profession:'radio-host',title:'Radio mix',published:true}];const flow=buildSiteFlow(data,[],now);assert.equal(flow.sections[0].type,'audio');assert.equal(flow.presentation.role.name,'Radio Host');assert.equal(flow.presentation.role.baseId,'dj');assert.deepEqual(withMainProfession(data.business.professions,'not-selected'),['radio-host']);
});
