import pathlib,json,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
p=pathlib.Path(sys.argv[1]);data=json.loads((p/'raw/summary.json').read_text())['summary']
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False})
fig,axes=plt.subplots(1,2,figsize=(10,4),sharey=True)
for ax,c in zip(axes,[1,8]):
 for mode,color,label in [('signed-status','#245ba6','Signed status'),('local-chain','#c45a24','Local chain')]:
  rows=sorted([r for r in data if r['concurrency']==c and r['mode']==mode],key=lambda r:r['delay'])
  x=[r['delay'] for r in rows];y=[r['medianOfRunMediansMs'] for r in rows]
  ax.errorbar(x,y,yerr=[[y[i]-r['runMedianMinMs'] for i,r in enumerate(rows)],[r['runMedianMaxMs']-y[i] for i,r in enumerate(rows)]],marker='o',capsize=4,label=label,color=color)
 ax.set_title(f'{c} concurrent worker'+('s' if c>1 else ''));ax.set_xlabel('Added one-way HTTP delay (ms)');ax.set_xticks([0,25,75]);ax.grid(alpha=.2);ax.legend()
axes[0].set_ylabel('Median verification latency (ms)')
fig.suptitle('TrustChain: controlled delay and verification latency',fontweight='bold')
fig.text(.5,.01,'Points: median of five run medians. Bars: min–max across runs (not confidence intervals).\nLocal synthetic workload; 24 measured attempts per condition per run.',ha='center',fontsize=8)
fig.tight_layout(rect=[0,.10,1,.94]);fig.savefig(p/'verification-latency.png',dpi=180);fig.savefig(p/'verification-latency.pdf');plt.close(fig)
