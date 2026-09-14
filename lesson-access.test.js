const test=require('node:test');
const assert=require('node:assert/strict');
const policy=require('./lesson-access');
for(const total of [0,1,2,8])test(`welcome course with ${total} lessons reserves its final lesson`,()=>{
  const first={id:'first',orden:1,clases:Array.from({length:total},(_,i)=>({num:i+1}))};
  const other={id:'other',orden:2,clases:[{num:1,isPreview:true},{num:2,isPreview:true}]};
  const courses=[other,first];
  for(let n=0;n<=total+1;n++)assert.equal(policy.isFreeLesson(courses,'first',n),n>=1&&n<total);
  for(let n=1;n<=2;n++) {
    assert.equal(policy.isFreeLesson(courses,'other',n),false);
    assert.equal(policy.canPlay({courses,courseId:'other',lessonNumber:n}),false);
    assert.equal(policy.canPlay({courses,courseId:'other',lessonNumber:n,hasMembership:true}),true);
    assert.equal(policy.canPlay({courses,courseId:'other',lessonNumber:n,isAdmin:true}),true);
  }
  if(total)assert.equal(policy.canPlay({courses,courseId:'first',lessonNumber:total,hasMembership:true}),true);
});
test('stable course order, hidden courses, numeric lesson order and invalid data',()=>{
  const courses=[{id:'z',orden:2,clases:[{num:1},{num:2}]},{id:'a',orden:2,clases:[{num:8},{num:2},{num:5}]},{id:'hidden',orden:1,activo:false,clases:[{num:1},{num:2}]}];
  assert.equal(policy.firstCourse(courses).id,'a');
  assert.equal(policy.isFreeLesson(courses,'a',2),true);
  assert.equal(policy.isFreeLesson(courses,'a',5),true);
  assert.equal(policy.isFreeLesson(courses,'a',8),false);
  assert.equal(policy.isFreeLesson(courses,'hidden',1),false);
  assert.equal(policy.isFreeLesson([],1,1),false);
  assert.equal(policy.isFreeLesson([{id:'a',clases:[{num:1},{num:1}]}],'a',1),false);
  assert.equal(policy.isFreeLesson([{id:'a',clases:[{num:1},{num:'invalid'}]}],'a',1),false);
  assert.equal(policy.canPlay({courses,courseId:'missing',lessonNumber:1,isAdmin:true}),false);
});
