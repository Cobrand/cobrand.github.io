---
layout: post
comments: true
title:  "The balance between cost, useability and soundness in C bindings, and Rust-SDL2's release"
date:   2017-05-07
categories: rust sdl2
---

Writing C-bindings in Rust is very easy to pick up (at least when you already got the hang of Rust), but unfortunately terribly hard to master: unsafety is at every corner, segmentation faults will often come and say hello while in development, and unsoundness itself is not that far fetched, even when your library practically "works". *For the uninitiated, we often talk of unsoundness when it's possible to use a dangling pointer, to call C functions in a way that leads to a crash, or simply doing something that is undefined behavior.*

With crates such as [sdl2](https://github.com/AngryLawyer/rust-sdl2/), it's very easy to build a crate that is unsound, less easy to build one that is sound but at a cost, and terribly hard (or even impossible sometimes, given Rust's sometimes excessive limitations) to create 0-cost soundness. On top of that, you have to make the sure the API is not too much of a hassle to use and respects Rust's idioms as much as possible, while still minimizing the cost overhead your API may have compared to the raw C calls.

A problem balancing those 3 emerged recently (it was actually here for quite a while but no one deemed changing that ... until now), and so we'll try to dive deeper into what the problems of rust-sdl2 were, how we tried to solve it, and what was the chosen solution in the end.

# The issues

The issues mainly concern Renderer, Window, and Texture this time, or the `render` part in general. Here is the [source code before the changes](https://github.com/AngryLawyer/rust-sdl2/tree/1a0d7d8a5a9408ddb529b2624ca4011e1dfd7a1e). Also, [here is what the documentation looked like](https://docs.rs/sdl2/0.29.1/sdl2/render/index.html).

For those who never used SDL2, here is a short explanation of how these work:

* `SDL_Window` is the struct in charge of creating a physical window and its properties (size, borderless, title, icon, ...), you cannot however draw a single pixel inside without using `SDL_Renderer` (or its inner `SDL_Surface`, but that's not the topic here).
* `SDL_Renderer` is the representation of one of your video drivers of your computer, linked to an `SDL_Window` or an `SDL_Surface`. You might know your drivers under the name opengl, direct3d (or DirectX), ... It can create `SDL_Texture`s from `SDL_Surface`s, which are representations of textures for the chosen driver, being very often located in your graphic card's internal memory. It's often created from a `SDL_Window`, but it can also be created from an `SDL_Surface`. Using this Renderer, you can effectively do anything you want: draw lines, copy textures, fil lthe whole area in a color, ... 
* `SDL_Surface` is simply an array of pixels in memory. It's slower to create and manipulate than an `SDL_Texture`, but also has its advantages, such as being able to dump the `SDL_Surface` in an image, or manipulating an image pixel per pixel in a rather fast manner.
* After all of that, you can use `SDL_SetRenderTarget` with your renderer. Long story short, your renderer draws by default to a Window (or a Surface), but `SDL_SetRenderTarget` gives you the option to draw to another `SDL_Texture` instead, meaning that all your functions that usually draw in your `SDL_Window` will be drawn into your `SDL_Texture` instead!

That's quite a lot of information for a summary, but I think all of these are needed to understand the big picture and how it affected the changes we made. Let's now list the issues the old Rust API that SDL2 had.

### Problem #0 : SDL\_Renderer cannot be destroyed after SDL\_Window

This is a prerequisite which is necessary for basic soundness. Due to how SDL is made, if a `SDL_Renderer` is created with a `SDL_Window` as a parent, using `SDL_DestroyRenderer` after `SDL_DestroyWindow` is undefined behavior (read: it will crash bad time). Because of that, we have to make sure to build our infrastructure around this constraint.

This is not an issue in our case, because it was already fixed long time ago, but this is still something to keep in mind for later.

### Problem #1 : Renderer is in charge of drawing and creating textures

Originally coming from [this issue](https://github.com/AngryLawyer/rust-sdl2/issues/630), the problem was quite simple: since `Renderer` was only one structure, you had to create textures with `&self` borrow and draw with `&mut self` borrow. This leads to the problem that you cannot create a texture while the "drawing" part is being borrowed somewhere else, even though you can safely do this in the original SDL. The safety part is mainly because a `Renderer` cannot be sent across threads due to SDL2's limitations.

A solution would be to use `UnsafeCell` inside renderer, and make all the methods use `&self` instead of `&mut self`: this is safe to do since `Renderer` cannot be sent across threads, and no-one will be able to use a `&mut` borrow twice on the same object.

Since `Renderer` also held a `Window` or a `Surface` (depending on the source it was created from), we also had to make them use `&self` instead of `&mut self`; this would have been fine for `Window`, since it has the same limitations as `Renderer` for threads, but `Surface` can definitely be sent across threads, and making every method of `&self` instead of `&mut self` was not something we wanted to do here, since it it would have meant using `UnsafeCell`, which cannot be sent across threads as well. We effectively had to remove the ability to use `Surface` into other threads, which was a huge downgrade we did not want to choose.

### Problem #2 : RenderTarget is a mess to use and uses states internally

In SDL2, `SDL_Renderer` can either draw to its source (Window or Surface) or to a Texture. You can only draw to a `Texture` by changing the `Renderer`'s target via `SDL_SetRenderTarget`, and all the draws will be done to that texture instead of the source. The old (pre 0.30) rust-sdl2 API on that side is almost the same: you can set a `RenderTarget`, and all draws will be done to that new target instead. 

Here is a simplfied version of how it's done pre-0.30:

```rust
impl<'a> Renderer<'a> {
  /// returns None if RenderTarget is not supported by the Renderer.
  pub fn render_target(&'a mut self) -> Option<RenderTarget<'a>> {
    // ...
  }
}

impl<'renderer> RenderTarget<'renderer> {
  /// Resets the render target its original window or surface.
  ///
  /// The old render target is returned if the function is successful.
  pub fn reset(&mut self) -> Result<Option<Texture>> {
    // ...
  }

  /// Sets the render target to the provided texture.
  ///
  /// The old render target is returned if the function is successful.
  pub fn set(&mut self, texture: Texture) -> Result<Option<Texture>, String> {
    // ...  
  }
}
```

and here is an example of how it works, taken from the documentation:

```rust
fn draw_to_texture(r: &mut Renderer) -> Texture {
  r.render_target()
    .expect("This platform doesn't support render targets")
    .create_and_set(PixelFormatEnum::RGBA8888, 512, 512);

  // Start drawing
  r.clear();
  r.set_draw_color(Color::RGB(255, 0, 0));
  r.fill_rect(Rect::new(100, 100, 256, 256));

  let texture: Option<Texture> = r.render_target().unwrap().reset().unwrap();
  texture.unwrap()
}
```

The main problem here is that there is no difference between a Renderer that draws to a Window and a Renderer that draws to a Texture. Worse: you can use your Renderer in your main loop, change your `RenderTarget` in-between without calling `reset` by mistake, and instead of drawing to a window you will unknowingly draw to a Texture. This problem derives directly from the fact that this struct is stateful, meaning that its state can be retrieved (for instance, the current RenderTarget) via methods, but there is no way to tell at compile time whether or not a target is the Window ... at least, for now.

Because it is theoritically possible to know at compile-time when is the RenderTarget a Texture and when it is a Window: by default, a Window is created with a renger target set to himself, `set(Texture)` calls obviously change the RenderTarget to a Texture, and `reset()` change it back to a window. So it *is* theoritically possible to keep track at compile-time what is the target of our renderer! We'll keep that in min for later.

### Problem #3 : Texture uses an Rc internally to track its parent

We talked about how `SDL_Renderer` should not be destroyed after `SDL_Window`, but I didn't mention the case of `SDL_Renderer` and `SDL_Texture`.
When `SDL_Renderer` is destroyed, all the `SDL_Texture` it has created are automatically destroyed as well. The only limitation is that you must not try to `SDL_DestroyTexture` after it has already been destroyed by its parent `Renderer`. Thus, a runtime check is needed to see whether or not the parent `Renderer` is still alive or not. If the Texture is being `Drop`ed while the `Renderer` is still alive, we can destroy the Texture safely. Otherwise, don't do anything since it has already been destroyed.

```rust
pub struct Texture {
  raw: *mut ll::SDL_Texture,
  is_renderer_alive: Rc<UnsafeCell<bool>>
}

impl Drop for Texture {
    fn drop(&mut self) {
        unsafe {
            if *self.is_renderer_alive.get() {
                ll::SDL_DestroyTexture(self.raw);
            }
        }
    }
}
```

A problem here, even though it's a minor one, is the use of `Rc` to track whether or not its parent is alive. Even though these are minor performance changes, they still are performance changes:

* The reference counter has to be updated when creating a new texture
* A runtime check is required when destroying a texture
* The reference counter has to be updated when destroying a new texture

They are all minor changes, but if you have hundreds of thousands `SDL_Texture` in your game, these changes might do the difference. The easiest way to fix that is to simply using *lifetimes*.

However, lifetimes aren't so simple, becaause we would be butting into problem #1 again, except even harder. Let me explain.

```rust
pub struct Texture<'r> {
  raw: *mut ll::SDL_Texture,
  _marker: PhantomData<&'r ()>,
}
```

What does the lifetime `'r` represent? The lifetime of its parent Renderer. Now that effectively means that every Texture borrows immutably its parent Renderer, **meaning that we cannot use Renderer mutably anymore** (at least if we have one Texture create or more, which will happen in all real-cases). We could try to change every method of `Renderer` to take `&self` instead of `&mut self`, but that would be butting into the first problem once again.

## Rust's missing feature: non-borrowing lifetimes

Something that we would have loved here is a *non-borrowing lifetime*. I know that given Rust's current implementation of immutable or mutable borrow, this is currently not possible, but just for the sake of "what if", let's try to dig in a little more into what this would have looked like.

The idea would be to allow lifetimes that don't borrow mutably or immutably something. This means that a structure being the target of a non-borrowing lifetime could be borrowed mutably, immutably, be moved, ... *but not be destroyed after the source of the non-borrowing lifetime*. The `Drop` part would be the only thing in common with a regular lifetime.

Now, I know that even if we tried to do this, this isn't actually possible because of what `&mut self` implies. What if someone called `mem::replace(...)` on a struct when there is a non-borrowing lifetime targeting it? `drop(..)`? This kind of question would make it either impossible to solve or would make Rust way more complex than it already is.

## Rust's alternative missing feature: partial struct borrows

However, another feature that would be theoritically possible at first glance in Rust but probably (very) hard to implement is the idea of partial borrows. [A thread was started almost 2 years ago](https://github.com/rust-lang/rfcs/issues/1215) about that problem, but there wasn't any progress since. Let me explain with this simple example (adapted from the linked issue's example) :

```rust
struct Point {
  x: f64,
  y: f64
}

impl Point {
  pub fn x_mut(&mut self) -> &mut f64 {
    &mut self.x
  }

  pub fn y_mut(&mut self) -> &mut f64 {
    &mut self.y
  }
}

fn main() {
  let mut point = Point { x: 1.0, y: 2.0 };
  { // OK
    let x_mut = &mut point.x;
    let y_mut = &mut point.y;
    *x_mut *= 2.0;
    *y_mut *= 2.0;
  }
  { // Illegal
    // error: cannot borrow `point` as mutable more than once at a time
    let x_mut = point.x_mut();
    //          ----- first mutable borrow occurs here
    let y_mut = point.y_mut();
    //          ^^^^^ second mutable borrow occurs here
    *x_mut *= 2.0;
    *y_mut *= 2.0;
  }
}
```

Currently, this code doesn't compile because of that second part: `point` cannot be borrowed more than once. This is a totally acceptable error given Rust's constraint about mutably borrowing, but wouldn't it have been better to be able to do this:

```rust
let x_mut = point.x_mut();
let y_mut = point.y_mut();
*x_mut *= 2.0;
*y_mut *= 2.0;
```

or even this:

```rust
let x_mut = point.x_mut();
let y_mut = &mut point.y;
*x_mut *= 2.0;
*y_mut *= 2.0;
```

What if you could hint the compiler to borrow only a set of elements of the struct instead of the struct itself? Like so:

```rust
impl Point {
  // THIS CODE DOESNT WORK, THIS IS A PROOF OF CONCEPT
  #[borrows(x)]
  pub fn x(&self) -> &f64 {
    &self.x
  }

  #[borrows(y)]
  pub fn y_mut(&mut self) -> &mut f64 {
    &mut self.y
  }

  #[borrows(x)]
  pub fn set_x(&mut self, new_x: f64) {
    self.x = new_x;
  }

  // writing nothing would borrow everything by default
  pub fn rotate90(&mut self) {
    self.x = -self.y;
    self.y = self.x;
  }
}

fn main() {
  let mut point = Point {x: 3.0, y: 4.0};
  {
    let x_mut = point.x_mut();
    {
      let y_mut = point.y_mut();
      *y_mut *= 2.0;
    }
    *x_mut *= 2.0;
  }
  point.rotate90();
}
// THIS CODE DOESNT WORK, THIS IS A PROOF OF CONCEPT
```

Of course, this is just an idea and I haven't put any thought for the syntax beyond what I've written up there. However, I think this idea could work. With such a syntax, you could be able to borrow multiple fields at once with`#[borrows(field1, field2, field3)]` and use another function that doesn't borrow these same fields. This would complexify the compiler by a tremendous amount I'm sure, but unless someone proves me wrong, this is theoritically possible.

So what would that bring for our problem? Well, put simply, it would be something like this:

```rust
// CODE HEAVILY SIMPLIFIED, PROOF OF CONCEPT ONLY
struct Renderer {
  context: RendererContext,
  parent: Window,
}

impl Renderer {
  #[borrows(context)]
  create_texture(&'a self) -> Texture<'a> {
    // ... create Texture from RendererContext here
  }

  #[borrows(parent)]
  window_mut(&mut self) -> &mut Window {
    &mut self.parent
  }
}
// CODE HEAVILY SIMPLIFIED, PROOF OF CONCEPT ONLY
```

Something like that would have been concise and quite nice to use: if you create `Texture`s, you can still use the inner Window (or Surface) mutably, which solves Problem 1 and Problem 3!

Such a feature would allow much more flexibility in Rust's code that we have now, for the better or for the worse. Keep in mind this isn't a Pre-RFC or anything, I just want to spark a discussion about what would this kind of feature bring to the current Rust ecosystem.

## The solution

Speculating about what things could be with "what if" can spark interesting discussions, but in the end we are interested in a solution! Here is what we came up with:

### Separate Renderer into 2 structs with different roles

Basically, we chose to separate the 2 roles of `Renderer` into two separate structs : `Canvas<Target>` and `TextureCreator`. Canvas represents the Renderer that draws, plus the thing being drawn on; this is basically a renamed `Renderer` except that we stripped the methods linked to texture creation. They went to the struct named `TextureCreator` instead, which you can create by calling `canvas.texture_creator()`. You can create multiple TextureCreator from the same Renderer if you like, they work all the same!

```rust
pub struct TextureCreator<T> {
  context: Rc<RendererContext<T>>
}

pub struct Canvas<T: RenderTarget> {
  target: T,
  context: Rc<RendererContext<T::Context>>,
}

impl<T> TextureCreator<T> {
  pub fn create_texture<F>(&'a self, ...) -> Texture<'a> {
    // ...
  }
}

main() {
  // PSEUDO CODE, NOT ACTUALLY WORKING
  // init window here

  let mut canvas = window.into_canvas();
  let texture_creator = canvas.texture_creator();
  let texture_creator2 = canvas.texture_creator();
  let texture = texture_creator.create_texture(...);
  // texture has a lifetime bound to its texture_creator

  canvas.copy(texture, None);
  canvas.present();
}
```

You can now borrow mutably a canvas while creating textures at the same time: exactly what we wanted!

Now that Texture has a lifetime which depends on TextureCreator, the `Rc<UnsafeCell<bool>>` isn't needed anymore, saving us runtime checks when using `Texture`s!

As a side-note, RendererContext is dropped only when the last Canvas or TextureCreator is dropped. It isn't shown here, but the RendererContext also holds a `Rc<Context>` (`Rc<WindowContext>` or `Rc<SurfaceContext>`) so that the Renderer is never dropped after the source it was created from.

### Making a temporary TextureCanvas to implement RenderTarget.

Remember the old `RenderTarget` struct that you used to set to change its target Texture? It's gone now!

```rust
impl Canvas<Window> {
  pub fn with_target<'r, 't, 'a>
      (&'r mut self,
       texture: &'t mut Texture<'a>)
       -> Result<Canvas<TextureTarget<'r, 't, WindowContext>>, TargetRenderError> {
      self.internal_with_target(texture)
  }
}

impl<'r, 't, TC> Drop for TextureTarget<'r, 't, TC> {
  fn drop(&mut self) {
    unsafe {
      ll::SDL_SetRenderTarget(*self.raw_renderer, ptr::null_mut());
    }
  }
}
```

Doing like so effectively means that we don't have to worry about what target our Renderer has at runtime, this is a compile-time problem now! Yay! Not only that, but changing target is now way more easy to use: no more juggling wih `Option<RenderTarget>` and setting or resetting them with tons of `unwrap`s and the like.

#### \[UDPATE\] Relying on Drop is actually a bad idea

It turns out that Rust cannot fully prevent memory leaks, and as such there is absolutely no guarantee that Drop will be called for sure. For instance, `mem::forget` is a totaly safe function, and can be called on `TextureTarget` without any problem for the compiler. The reality, however, is quite unsound! Not `Drop`ing here would mean that the `Renderer` would internally keep rendering to the `Texture` instead of the source `Window` or `Surface`. This would have been pretty acceptable if it was not for the fact that the Texture can actually be dropped right after that, while still being referened by that renderer. This would effectively lead to a use-afer-free, which is very bad news for us.

Fortunately, another solution is to wrap the new `Canvas` in a closure, setting the correct target before the closure is called, and resetting it after it is called. Full details [here](https://github.com/AngryLawyer/rust-sdl2/issues/657).

## 🎉 The release of rust-sdl2 0.30.0-beta 

All of this led to a single thing in the end: [rust-sdl2's 0.30 beta release](https://github.com/AngryLawyer/rust-sdl2/blob/master/changelog.md#v030) ([crates.io](https://crates.io/crates/sdl2/0.30.0-beta))! Not much on the side of functionality, but a lot more on the side of usability! Even though the library has been tested, it has not be *thoroughly* tested. We prefer having beta-testers for this release to make sure the library is safe to use for a stable release. Once we are sure the binding is safe to use, we'll release 0.30 for real.

Huge thanks to @nrxus for [his help](https://github.com/AngryLawyer/rust-sdl2/pull/632)! Nothing would have been possible without him!

## Conclusion

I think that if a feature like partial borrow emerged one day, we would be able to make a 100% sound, 0-cost and very easy to use crate. But this is still a "what if", and focusing on the present, we still have soundness here, but we had to balance cost of the API with useability of the crate to make it both enjoyable and efficient to use.

In the end, I think this is the best possible outcome we could have found given current Rust's capabilities, so no regrets!

... Well, at least for the `render` part of SDL2. Many of the other modules in rust-sdl2 are incomplete or awkward to use; the C SDL2 library has been stable for a while, but rust-sdl2's API still is not. [Some functionalities are missing](https://github.com/AngryLawyer/rust-sdl2/issues?q=is%3Aissue+is%3Aopen+label%3Afunctionality), [some implementations are lacking or not complete](https://github.com/AngryLawyer/rust-sdl2/labels/enhancement), while other are even totally [unsound](https://github.com/AngryLawyer/rust-sdl2/issues/616) at times. We would love to see your help in here, so that rust-sdl2 can finally come to a stable 1.0 release; of course, beginners are welcome to create a Pull Request as well!
