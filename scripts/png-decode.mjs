import zlib from 'node:zlib';
export function decode(buf){
  let p=8,w,h,bd,ct,il,pal,trns;const idat=[];
  while(p<buf.length){const n=buf.readUInt32BE(p),t=buf.toString('latin1',p+4,p+8),d=buf.subarray(p+8,p+8+n);p+=12+n;
    if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);bd=d[8];ct=d[9];il=d[12];}
    else if(t==='PLTE')pal=d;else if(t==='tRNS')trns=d;else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;}
  if(il||bd!==8)throw new Error('unsupported '+il+' '+bd);
  const ch={0:1,2:3,3:1,4:2,6:4}[ct],raw=zlib.inflateSync(Buffer.concat(idat)),st=w*ch,out=new Uint8Array(w*h*4);
  let prev=new Uint8Array(st),q=0;
  for(let y=0;y<h;y++){const f=raw[q++],cur=new Uint8Array(st);
    for(let i=0;i<st;i++){const v=raw[q++],a=i>=ch?cur[i-ch]:0,b=prev[i],c=i>=ch?prev[i-ch]:0;let r;
      if(f===0)r=0;else if(f===1)r=a;else if(f===2)r=b;else if(f===3)r=(a+b)>>1;else{const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);r=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
      cur[i]=(v+r)&255;}
    for(let x=0;x<w;x++){const k=(y*w+x)*4,s=x*ch;
      if(ct===6){out[k]=cur[s];out[k+1]=cur[s+1];out[k+2]=cur[s+2];out[k+3]=cur[s+3];}
      else if(ct===2){out[k]=cur[s];out[k+1]=cur[s+1];out[k+2]=cur[s+2];out[k+3]=255;}
      else if(ct===0){out[k]=out[k+1]=out[k+2]=cur[s];out[k+3]=255;}
      else if(ct===4){out[k]=out[k+1]=out[k+2]=cur[s];out[k+3]=cur[s+1];}
      else{const j=cur[s];out[k]=pal[j*3];out[k+1]=pal[j*3+1];out[k+2]=pal[j*3+2];out[k+3]=trns&&j<trns.length?trns[j]:255;}}
    prev=cur;}
  return {w,h,d:out};
}
