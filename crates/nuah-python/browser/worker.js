var f=`import os
os.environ.setdefault("MPLBACKEND", "AGG")`,y=`
def __nuah_figures():
    import sys
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import io
    import matplotlib.pyplot as plt
    out = []
    for n in plt.get_fignums():
        b = io.BytesIO()
        plt.figure(n).savefig(b, format="png", bbox_inches="tight")
        out.append(b.getvalue())
    plt.close("all")
    return out
__nuah_figures()`,d=new WeakSet;async function l(t,o,a={}){let n=Date.now(),s="",i="";t.setStdout({batched:e=>{s+=e+`
`}}),t.setStderr({batched:e=>{i+=e+`
`}});try{d.has(t)||(await t.runPythonAsync(f),d.add(t)),await t.loadPackagesFromImports(o,{messageCallback:()=>{}});let e=await t.runPythonAsync(o);typeof e=="number"||typeof e=="string"||typeof e=="boolean"?s+=String(e)+`
`:e?.destroy?.();let r=await t.runPythonAsync(y),c=r.toJs();r.destroy?.();let g=c.map((m,p)=>({name:`figure-${p+1}.png`,type:"image/png",bytes:new Uint8Array(m)}));return{ok:!0,stdout:s,stderr:i,files:g,ms:Date.now()-n}}catch(e){let r=e instanceof Error?e.message:String(e);return{ok:!1,stdout:s,stderr:i+r+(r.endsWith(`
`)?"":`
`),files:[],ms:Date.now()-n}}}var b="0.29.5",u=new URL("./",import.meta.url).href,P=null,h=()=>P??=import(`${u}pyodide.mjs`).then(t=>t.loadPyodide({indexURL:u,packageBaseUrl:`https://cdn.jsdelivr.net/pyodide/v${b}/full/`}));self.onmessage=async t=>{let{id:o,source:a}=t.data;self.postMessage({id:o,progress:{stage:"running"}});let n=await l(await h(),a);self.postMessage({id:o,result:n},n.files.map(s=>s.bytes.buffer))};export{b as PYODIDE_VERSION};
