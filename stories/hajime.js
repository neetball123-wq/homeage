/* はじまり。話とは関係なく、何かが始まるところ */
HOMEAGE.story(`
id: hajime
title: はじまり
layer: 0

# boot
ui: boot label=読み込み中 stuck=…… hold=長押し
* つづける -> field

# field
place: ？
@2まっくらだ。
@2どこかで、何かの音がする。
ui: field hint=なぞって、さがす
* ころん -> @kushami | x=28 y=72
* わっしょい -> @ukishizu | x=74 y=20
* なまえは？ -> @nagana | x=22 y=28
* まね、しないで -> @mane | x=66 y=56
* いち、たくさん -> @amata | x=46 y=40
* うしろ、うしろ -> @ushirome | x=78 y=84
`);
