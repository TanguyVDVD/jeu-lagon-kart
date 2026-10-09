import {sampleCustomTrackAnchors,type CustomTrackDraft,type TrackWorkshopSelection} from './custom-tracks.js';
import type {Vec2} from './track.js';

export type TrackModuleSelection=TrackWorkshopSelection&{handle?:'target'|'trigger'};
export function customTrackModule(draft:CustomTrackDraft,selection:TrackModuleSelection){
  if(selection.group==='track'||!Number.isInteger(selection.index)||selection.index<0)return undefined;
  return draft[selection.group]?.[selection.index];
}
/** Project touch/mouse position onto the existing spline, without resampling or
 * changing its geometry. Near ties at crossings favour the selected section. */
export function projectCustomTrackPoint(draft:CustomTrackDraft,point:Vec2,reference=0):{fraction:number;offset:number}|undefined {
  const points=sampleCustomTrackAnchors(draft.anchors);if(!points.length||!Number.isFinite(point.x+point.z))return;
  const lengths=points.map((a,index)=>Math.hypot(points[(index+1)%points.length]!.x-a.x,points[(index+1)%points.length]!.z-a.z));
  const total=lengths.reduce((a,b)=>a+b,0);if(total<=1e-6)return;
  let cumulative=0,bestDistance=Infinity,bestReference=Infinity,best:{fraction:number;offset:number}|undefined;
  points.forEach((a,index)=>{
    const length=lengths[index]!,b=points[(index+1)%points.length]!;
    if(length>1e-8){
      const dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.z-a.z)*dz)/(length*length)));
      const x=a.x+dx*t,z=a.z+dz*t,distance=Math.hypot(point.x-x,point.z-z),fraction=(cumulative+length*t)/total;
      const difference=Math.abs(fraction-reference),referenceDistance=Math.min(difference,1-difference);
      if(distance<bestDistance-.05||Math.abs(distance-bestDistance)<=.05&&referenceDistance<bestReference){
        bestDistance=distance;bestReference=referenceDistance;best={fraction,offset:((point.x-x)*dz-(point.z-z)*dx)/length};
      }
    }
    cumulative+=length;
  });return best;
}
/** Clamp the complete interval at the finish line: dragging never shortens a
 * zone, bridge or event. A switch's plate and target move independently. */
export function moveCustomTrackModule(draft:CustomTrackDraft,selection:TrackModuleSelection,fraction:number,offset?:number):boolean {
  const feature=customTrackModule(draft,selection);if(!feature||!Number.isFinite(fraction))return false;
  const before=JSON.stringify(feature);
  if(selection.group==='interactions'&&selection.handle==='trigger'&&'trigger'in feature)feature.trigger=Math.max(0,Math.min(.999,fraction));
  else {const length=feature.end-feature.start;feature.start=Math.max(0,Math.min(1-length,fraction));feature.end=feature.start+length;}
  if(Number.isFinite(offset)&&'width'in feature&&'offset'in feature)feature.offset=Math.max(-(draft.width-feature.width)/2,Math.min((draft.width-feature.width)/2,offset!));
  return JSON.stringify(feature)!==before;
}
