---
layout: post
title: "认识java"
date: 2023-8-31 10:00:00 +0800
categories: text
---

1.认识Java之父
詹姆斯·高斯林 （James Gosling）是一名软件专家，1955年5月19日出生于加拿大，Java编程语的共同创始人之一，一般公认他为“Java之父”。

1977年获得了加拿大卡尔加里大学计算机科学学士学位，1983年获得了美国卡内基梅隆大学计算机科学博士学位。
![text](https://imgconvert.csdnimg.cn/aHR0cDovL2ltZzQuaW1ndG4uYmRpbWcuY29tL2l0L3U9MjMzMDc4ODQ1NSwzNTA4MDMxNDU5JmZtPTI2JmdwPTAuanBn?x-oss-process=image/format,png#pic_center)


2.什么是Java
Java是一门面向对象编程语言，不仅吸收了C++语言的各种优点，还摒弃了C++里难以理解的多继承、指针等概念，因此Java语言具有功能强大和简单易用两个特征。Java语言作为静态面向对象编程语言的代表，极好地实现了面向对象理论，允许程序员以优雅的思维方式进行复杂的编程 。

3.Jdk三大版本
JavaSE（Java Standard Edition）是Java平台的标准版，它提供了用于开发和部署Java应用程序的核心API和工具。JavaSE是Java的基础，包含了Java语言的核心库、Java虚拟机（JVM）和开发工具，适用于桌面应用程序、嵌入式设备、移动设备和服务器应用程序等。

JavaME（Java Micro Edition）是Java平台的微型版，专门用于嵌入式和移动设备的开发。JavaME提供了一套精简的API和配置文件，以支持资源受限的设备，如手机、智能卡、个人数字助理（PDA）等。它适用于开发小型应用程序和游戏，具有较小的内存和处理能力要求。

JavaEE（Java Enterprise Edition）是Java平台的企业版，用于开发和部署企业级应用程序。JavaEE提供了一套丰富的API和规范，用于构建分布式、可扩展和安全的企业应用程序，如Web应用程序、企业级服务、消息传递系统等。JavaEE包括各种技术，如Servlet、JSP、EJB、JMS、JPA等，以满足企业级应用程序的需求。



总结：

JavaSE是Java的标准版，适用于桌面应用程序、嵌入式设备、移动设备和服务器应用程序。
JavaME是Java的微型版，专门用于嵌入式和移动设备的开发，适用于资源受限的设备。
JavaEE是Java的企业版，用于开发和部署企业级应用程序，提供了一套丰富的API和规范。
4.jdk的安装和环境的搭建
以下是安装JDK（Java开发工具包）的步骤：

1. 访问官方网站，下载对应平台的JDK安装文件（例如Windows或Linux）。

2. 双击下载的安装文件，按照提示进行安装。

3. 在安装过程中，选择安装路径和相关选项。通常情况下，推荐使用默认设置。

4. 完成安装后，打开命令行工具（如Windows的CMD或Linux的终端）。

5. 输入命令“java -version”并按下回车键，如果成功安装，将会显示JDK的版本号和其他相关信息。

6. 对于Windows操作系统，还需要将JDK所在的安装目录添加到环境变量中。具体操作方式为：

    - 在桌面上右键单击“计算机”（或“My Computer”）图标，选择“属性”。

    - 点击“高级系统设置”（或“Advanced system settings”）。

    - 点击“环境变量”（或“Environment Variables”）。

    - 在“系统变量”（或“System variables”）区域里找到“Path”变量，点击“编辑”（或“Edit”）。

    - 在变量值后面添加JDK的安装路径，多个路径之间用分号隔开。

7. 安装完成后，可以使用任何支持Java的开发工具（如Eclipse或IntelliJ IDEA）进行Java编程。

5.JVM、JRE和JDK的关系
JVM（Java虚拟机）是Java程序的运行环境，它负责将Java源代码编译成字节码并执行。JVM是跨平台的，可以在不同的操作系统上运行Java程序。

JRE（Java运行时环境）是JVM的一部分，它包含了JVM以及Java程序运行所需的核心类库和支持文件。JRE只能用于运行Java程序，无法用于开发。

JDK（Java开发工具包）是Java开发的核心工具，它包含了JRE以及用于开发Java程序的编译器（javac）、调试器（jdb）等工具。JDK提供了开发Java程序所需的所有功能和工具。

因此，JDK包含了JRE，而JRE又包含了JVM。在开发Java程序时，需要安装JDK，而在运行Java程序时，只需要安装JRE即可。
![text](https://tse1-mm.cn.bing.net/th/id/OIP-C.exRq6KX_cPu-CenmyerhwgAAAA?pid=ImgDet&rs=1)

6.Java语言的特点
Java具有以下特点：

1. 跨平台性：Java程序可以在不同的操作系统上运行，只需在目标操作系统上安装对应的JRE即可。这是因为Java程序是在JVM上运行的，JVM负责将Java字节码转换为特定平台的机器码。

2. 面向对象：Java是一种面向对象的编程语言，支持封装、继承和多态等面向对象的特性。这使得Java具有更好的可重用性、可扩展性和可维护性。

3. 安全性：Java提供了一系列安全性特性，如内存管理、异常处理和安全沙箱等。Java程序在JVM上运行，JVM会对程序进行严格的安全检查，防止恶意代码的执行。

4. 简单易学：Java语法相对简单，与C++相比，去除了一些复杂的特性，如指针和操作符重载。Java还提供了丰富的类库，简化了开发过程。

5. 多线程支持：Java内置了多线程支持，可以方便地创建和管理多线程。这使得Java适用于开发多线程并发的应用程序，提高了程序的性能和响应能力。

6. 高性能：尽管Java是解释执行的，但通过JIT（即时编译）技术，Java程序可以在运行时进行优化，达到接近原生代码的性能。

7. 大型生态系统：Java拥有庞大的开发者社区和丰富的第三方库和框架。这使得Java成为一个非常强大的开发平台，可以用于开发各种类型的应用程序，从桌面应用到企业级应用都有很好的支持。

总的来说，Java是一种功能强大、安全性高、跨平台的编程语言，适用于各种类型的应用开发。

7.第一个Java程序HelloWorld
```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello World!");
    }
}
```
解释：

public class HelloWorld：定义了一个名为HelloWorld的公共类。每个Java程序都需要有一个公共类，并且类名必须与文件名相同。
public static void main(String[] args)：main方法是Java程序的入口点，程序从这里开始执行。它是一个公共的、静态的（static）方法，没有返回值（void）。String[] args是main方法的参数，用于接收命令行输入的参数。
System.out.println("Hello World!");：这行代码用于在控制台输出字符串"Hello World!"。System.out是Java提供的标准输出流，println是一个方法，用于输出字符串并换行。
要运行这个程序，需要先安装Java开发工具包（JDK），然后将上述代码保存为一个名为HelloWorld.java的文件。在命令行中进入该文件所在的目录，然后使用以下命令编译和运行程序：

javac HelloWorld.java // 编译Java源文件，生成字节码文件 HelloWorld.class

java HelloWorld // 运行生成的字节码文件

执行后，控制台将输出"Hello World!"。这是Java程序的基本结构，可以通过修改和扩展来构建更复杂的应用程序。

好啦,现在你的第一个Java程序已经写好啦,一起开始你的Java之旅吧.加油!!!
