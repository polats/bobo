// Knitted pictures as stitch charts, one character per stitch, top row first (the row on the
// needle). Each chart has its own palette of yarn colours.

export interface Picture {
  name: string;
  palette: Record<string, string>;
  rows: string[];
}

export const PICTURES: Picture[] = [
  {
    name: 'Mushroom',
    palette: { b: '#8fd3ff', r: '#e8364f', w: '#fff4e6', s: '#f1d3a8', g: '#5cc05a' },
    rows: [
      'bbbbbbbbbbbbbbbb',
      'bbbbbrrrrrrbbbbb',
      'bbbrrwwrrrrrrbbb',
      'bbrrwwwwrrrwwrbb',
      'brrrrwwrrrwwwwrb',
      'brwwrrrrrrrwwrrb',
      'rwwwwrrrwwrrrrrr',
      'rrwwrrrwwwwrrwwr',
      'rrrrrrrrwwrrrwwr',
      'bbbbbssssssbbbbb',
      'bbbbbssssssbbbbb',
      'bbbbsssssssbbbbb',
      'bbbbssssssssbbbb',
      'gbbbssssssssbbbg',
      'ggggggssssgggggg',
      'gggggggggggggggg',
    ],
  },
  {
    name: 'Bobo',
    palette: { l: '#c9b6ff', p: '#ff6fae', k: '#3a1838', w: '#ffffff', c: '#ff9ec7', y: '#ffd166' },
    rows: [
      'llllllllllllllll',
      'llllylllllllylll',
      'lllllpppppplllll',
      'lllpppppppppplll',
      'llpppppppppppppl',
      'lppkkpppppkkpppl',
      'lppkwpppppkwpppl',
      'lppkkpppppkkpppl',
      'lcccpppppppcccpl',
      'lpcppkppppkppcpl',
      'lpppppkkkkpppppl',
      'llpppppppppppppl',
      'lllpppppppppplll',
      'lllllppppppllyll',
      'llyllllllllllyll',
      'llllllllllllllll',
    ],
  },
  {
    name: 'Sunset',
    palette: { y: '#ffd166', o: '#ff8a3d', r: '#ef476f', v: '#7b5cff', n: '#1f3b73', t: '#2ec4b6' },
    rows: [
      'vvvvvvvvvvvvvvvv',
      'vvvrrrrrrrrrrvvv',
      'rrrrrrooorrrrrrr',
      'rrrroooyyyooorrr',
      'ooooooyyyyyooooo',
      'oooooyyyyyyyoooo',
      'yyyyyyyyyyyyyyyy',
      'tttttttttttttttt',
      'ttnntttnnnttttnn',
      'nnnnttnnnnnttnnn',
      'nnnnnnnnnnnnnnnn',
      'ntnnnnnntnnnnntn',
      'nnnnnttnnnnnnnnn',
      'nnnnnnnnnnnttnnn',
    ],
  },
];
